#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

export interface ScheduledDigest {
  run_key: string;
  title: string;
  body: string;
  source_urls?: string[];
  occurred_at?: string;
}

export type ScheduledDigestPublisher = (input: ScheduledDigest) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

const safeText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), "control characters are not allowed");
const httpsUrl = z.string().min(1).max(1_000).url()
  .refine((value) => new URL(value).protocol === "https:", "source URL must use HTTPS");

export function createCodexScheduledStdioProxy(publish: ScheduledDigestPublisher): McpServer {
  const server = new McpServer({ name: "totemora-codex-scheduled-news", version: "1.0.0" }, {
    instructions: "This project-scoped server only publishes the final result of the explicitly subscribed daily news task. Never call it from ordinary conversations or for progress updates. Use one Asia/Shanghai YYYY-MM-DD run_key per day; retries must reuse the same key. Totemora enforces one Telegram message per subscription per day.",
  });
  server.registerTool("publish_scheduled_digest", {
    title: "Publish subscribed scheduled digest",
    description: "Publish one completed daily-news digest to its explicitly subscribed Telegram group.",
    inputSchema: {
      run_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
      title: safeText(200),
      body: safeText(12_000),
      source_urls: z.array(httpsUrl).max(5).optional(),
      occurred_at: z.string().datetime({ offset: true }).optional(),
    },
    annotations: {
      title: "Publish scheduled digest",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async (input) => publish(input));
  return server;
}

export async function publishScheduledDigestToRemote(input: ScheduledDigest): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const endpoint = scheduledEndpoint();
  const tokenPath = process.env.TOTEMORA_SCHEDULED_NEWS_TOKEN_FILE?.trim()
    || resolve(import.meta.dir, "../../../.totemora/secrets/codex-scheduled-news-token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token || token.length > 4_096) throw new Error("scheduled-news capability file is empty or invalid");

  const client = new Client({ name: "totemora-codex-scheduled-news-proxy", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return await client.callTool({
      name: "publish_scheduled_digest",
      arguments: {
        run_key: input.run_key,
        title: input.title,
        body: input.body,
        ...(input.source_urls ? { source_urls: input.source_urls } : {}),
        ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
      },
    }) as Awaited<ReturnType<ScheduledDigestPublisher>>;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function scheduledEndpoint(): URL {
  const endpoint = new URL(
    process.env.TOTEMORA_SCHEDULED_NEWS_ENDPOINT?.trim()
      || "https://totemora.qzhqzh.com/mcp/codex-scheduled",
  );
  if (endpoint.protocol !== "https:") throw new Error("scheduled-news MCP endpoint must use HTTPS");
  return endpoint;
}

if (import.meta.main) {
  const server = createCodexScheduledStdioProxy(async (input) => {
    try {
      return await publishScheduledDigestToRemote(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `定时新闻投递失败：${message.slice(0, 500)}` }],
        isError: true,
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
