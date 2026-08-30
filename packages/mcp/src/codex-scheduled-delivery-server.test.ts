import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  createCodexScheduledDeliveryMcpHttpHandler,
  createCodexScheduledDeliveryMcpServer,
} from "./codex-scheduled-delivery-server";

test("scheduled delivery capability exposes exactly one idempotent publishing tool", async () => {
  const calls: Array<{ token: string; input: unknown }> = [];
  const operations = {
    authorize: () => true,
    publish: (token: string, input: unknown) => {
      calls.push({ token, input });
      return { delivered: true, replayed: false };
    },
  };
  const server = createCodexScheduledDeliveryMcpServer(operations, "subscription-capability");
  const client = new Client({ name: "scheduled-delivery-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual(["publish_scheduled_digest"]);
  expect(tools.tools[0]?.annotations).toMatchObject({ idempotentHint: true, destructiveHint: false });
  await client.callTool({
    name: "publish_scheduled_digest",
    arguments: {
      run_key: "2026-08-30", title: "每日新闻", body: "三条重点。",
      source_urls: ["https://example.com/news"], occurred_at: "2026-08-30T08:00:00+08:00",
    },
  });
  expect(calls).toEqual([expect.objectContaining({ token: "subscription-capability" })]);
  await client.close();
  await server.close();
});

test("scheduled delivery HTTP endpoint rejects missing capabilities before MCP dispatch", async () => {
  const handler = createCodexScheduledDeliveryMcpHttpHandler({ authorize: () => false, publish: () => ({}) });
  expect((await handler(new Request("http://local/mcp/codex-scheduled", { method: "GET" }))).status).toBe(405);
  expect((await handler(new Request("http://local/mcp/codex-scheduled", { method: "POST" }))).status).toBe(401);
});

test("scheduled delivery HTTP capability dispatches its only tool and bounds authenticated bodies", async () => {
  const calls: unknown[] = [];
  const handler = createCodexScheduledDeliveryMcpHttpHandler({
    authorize: (token) => token === "scheduled-token",
    publish: (_token, input) => { calls.push(input); return { delivered: true }; },
  });
  const httpServer = Bun.serve({ port: 0, fetch: handler });
  const client = new Client({ name: "scheduled-http-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${httpServer.port}/mcp/codex-scheduled`),
    { requestInit: { headers: { authorization: "Bearer scheduled-token" } } },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "publish_scheduled_digest",
      arguments: { run_key: "2026-08-30", title: "Daily", body: "Final digest" },
    });
    expect(result.structuredContent).toMatchObject({ delivered: true });
    const multilingual = await client.callTool({
      name: "publish_scheduled_digest",
      arguments: { run_key: "2026-08-31", title: "中文日报", body: "汉".repeat(12_000) },
    });
    expect(multilingual.structuredContent).toMatchObject({ delivered: true });
    expect(calls).toHaveLength(2);
  } finally {
    await client.close();
    httpServer.stop(true);
  }

  const oversized = await handler(new Request("http://local/mcp/codex-scheduled", {
    method: "POST",
    headers: { authorization: "Bearer scheduled-token", "content-length": "65537" },
    body: "{}",
  }));
  expect(oversized.status).toBe(413);

  const chunkedMultibyteRequest = new Request("http://local/mcp/codex-scheduled", {
    method: "POST",
    headers: { authorization: "Bearer scheduled-token" },
    body: "汉".repeat(22_000),
  });
  expect(chunkedMultibyteRequest.headers.get("content-length")).toBeNull();
  expect((await handler(chunkedMultibyteRequest)).status).toBe(413);
});

test("scheduled delivery HTTP capability permits only one in-flight request per token", async () => {
  let calls = 0;
  let markStarted!: () => void;
  let releasePublish!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
  const handler = createCodexScheduledDeliveryMcpHttpHandler({
    authorize: () => true,
    publish: async () => {
      calls += 1;
      markStarted();
      await publishGate;
      return { delivered: true };
    },
  });
  const httpServer = Bun.serve({ port: 0, fetch: handler });
  const url = new URL(`http://127.0.0.1:${httpServer.port}/mcp/codex-scheduled`);
  const clients = [
    new Client({ name: "scheduled-concurrency-a", version: "1" }),
    new Client({ name: "scheduled-concurrency-b", version: "1" }),
  ];
  try {
    for (const client of clients) {
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: "Bearer scheduled-token" } },
      }));
    }
    const first = clients[0]!.callTool({
      name: "publish_scheduled_digest",
      arguments: { run_key: "run-a", title: "Daily", body: "Final digest" },
    });
    await started;
    await expect(clients[1]!.callTool({
      name: "publish_scheduled_digest",
      arguments: { run_key: "run-b", title: "Daily", body: "Final digest" },
    })).rejects.toThrow();
    releasePublish();
    expect((await first).structuredContent).toMatchObject({ delivered: true });
    expect(calls).toBe(1);
  } finally {
    releasePublish();
    await Promise.allSettled(clients.map((client) => client.close()));
    httpServer.stop(true);
  }
});

test("scheduled delivery HTTP capability rate limits repeated requests per token", async () => {
  const handler = createCodexScheduledDeliveryMcpHttpHandler({ authorize: () => true, publish: () => ({}) });
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "scheduled-rate-test", version: "1" },
    },
  });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await handler(new Request("http://local/mcp/codex-scheduled", {
      method: "POST",
      headers: { authorization: "Bearer scheduled-token", "content-type": "application/json" },
      body: initialize,
    }));
    expect(response.status).not.toBe(429);
  }
  const limited = await handler(new Request("http://local/mcp/codex-scheduled", {
    method: "POST",
    headers: { authorization: "Bearer scheduled-token", "content-type": "application/json" },
    body: initialize,
  }));
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBeTruthy();
});
