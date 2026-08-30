import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCodexScheduledStdioProxy, type ScheduledDigest } from "./codex-scheduled-stdio-proxy";

test("scheduled-news stdio proxy exposes only the subscribed publish tool", async () => {
  const calls: ScheduledDigest[] = [];
  const server = createCodexScheduledStdioProxy(async (input) => {
    calls.push(input);
    return {
      content: [{ type: "text", text: "delivered" }],
      structuredContent: { delivered: true },
    };
  });
  const client = new Client({ name: "scheduled-news-proxy-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["publish_scheduled_digest"]);
    expect(tools.tools[0]?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    const result = await client.callTool({
      name: "publish_scheduled_digest",
      arguments: {
        run_key: "2026-08-30",
        title: "每日中立新闻",
        body: "三条值得关注的消息。",
        source_urls: ["https://example.com/news"],
        occurred_at: "2026-08-30T08:00:00+08:00",
      },
    });
    expect(result.structuredContent).toEqual({ delivered: true });
    expect(calls).toEqual([expect.objectContaining({ run_key: "2026-08-30" })]);
  } finally {
    await client.close();
    await server.close();
  }
});
