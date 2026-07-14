import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createTotemoraMcpHttpHandler } from "./http";

test("serves authenticated MCP tool discovery over Streamable HTTP", async () => {
  const gatewayFetch = async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/status") return Response.json({ version: "0.4.0-mcp-gateway", settlement: "ready" });
    if (pathname === "/api/tribe") return Response.json({ tribe: { id: "first-fire", name: "初火部落" }, members: [] });
    return Response.json({ error: "not found" }, { status: 404 });
  };
  const handler = createTotemoraMcpHttpHandler({
    gatewayUrl: "http://gateway.local",
    operatorToken: "operator-token",
    fetch: gatewayFetch as typeof fetch,
  });
  const httpServer = Bun.serve({ port: 0, fetch: handler });
  const client = new Client({ name: "http-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer operator-token" } },
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "totemora_start_git_flow")).toBe(true);
    const status = await client.callTool({ name: "totemora_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ status: { settlement: "ready" } });
  } finally {
    await client.close();
    httpServer.stop(true);
  }
});

test("rejects unauthenticated MCP requests", async () => {
  const handler = createTotemoraMcpHttpHandler({
    gatewayUrl: "http://gateway.local",
    operatorToken: "operator-token",
  });
  const response = await handler(new Request("http://localhost/mcp", { method: "POST" }));
  expect(response.status).toBe(401);
});
