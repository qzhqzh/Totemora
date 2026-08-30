import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCodexAgentMcpHttpHandler, createCodexAgentMcpServer } from "./codex-agent-server";

test("restricted Codex agent profile exposes only checkpoint and interaction reporting", async () => {
  const calls: Array<{ operation: string; token: string; input: unknown }> = [];
  const operations = {
    authorize: () => true,
    raiseInteraction: (token: string, input: unknown) => {
      calls.push({ operation: "interaction", token, input });
      return { id: "interaction-1", status: "open" };
    },
    reportCheckpoint: (token: string, input: unknown) => {
      calls.push({ operation: "checkpoint", token, input });
      return { id: "checkpoint-1", status: "resolved" };
    },
  };
  const server = createCodexAgentMcpServer(operations, "turn-capability");
  const client = new Client({ name: "codex-agent-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual([
    "codex_raise_interaction",
    "codex_report_checkpoint",
  ]);
  expect(tools.tools.some((tool) => tool.name.includes("approve") || tool.name.includes("manage"))).toBe(false);
  await client.callTool({
    name: "codex_report_checkpoint",
    arguments: {
      summary: "implemented migration", evidence: ["bun test passed"], remaining_work: ["wire routes"],
      next_step: "add HTTP API", outcome: "progress",
    },
  });
  expect(calls).toEqual([expect.objectContaining({ operation: "checkpoint", token: "turn-capability" })]);
  await client.close();
  await server.close();
});

test("Codex agent HTTP capability rejects oversized requests before MCP parsing", async () => {
  const handler = createCodexAgentMcpHttpHandler({
    authorize: () => true,
    raiseInteraction: () => ({ id: "interaction-1" }),
    reportCheckpoint: () => ({ id: "checkpoint-1" }),
  });
  const response = await handler(new Request("http://localhost/mcp/codex-agent", {
    method: "POST",
    headers: {
      authorization: "Bearer turn-capability",
      "content-length": String(64 * 1_024 + 1),
      "content-type": "application/json",
    },
    body: "{}",
  }));

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "MCP request exceeds 65536 bytes" });
});
