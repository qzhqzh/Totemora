import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { totemoraProductVersion } from "@totemora/core";

import { McpRequestTooLargeError, readBoundedMcpRequest } from "./bounded-mcp-request";

export interface CodexScheduledDeliveryMcpOperations {
  authorize(token: string): boolean | Promise<boolean>;
  publish(token: string, input: {
    run_key: string;
    title: string;
    body: string;
    source_urls?: string[];
    occurred_at?: string;
  }): unknown | Promise<unknown>;
}

const safeText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), "control characters are not allowed");
const httpsUrl = z.string().min(1).max(1_000).url()
  .refine((value) => {
    try { return new URL(value).protocol === "https:"; }
    catch { return false; }
  }, "source URL must use HTTPS");
const MCP_REQUEST_LIMIT = 64 * 1_024;
const CAPABILITY_RATE_LIMIT = 12;
const CAPABILITY_RATE_WINDOW_MS = 60_000;

export function createCodexScheduledDeliveryMcpServer(
  operations: CodexScheduledDeliveryMcpOperations,
  token: string,
): McpServer {
  const server = new McpServer({ name: "totemora-codex-scheduled-delivery", version: totemoraProductVersion() }, {
    instructions: "This restricted profile can only publish a final result for the exact scheduled-task subscription identified by its bearer capability. It cannot list conversations, select another subscription, or use any other Totemora action.",
  });
  server.registerTool("publish_scheduled_digest", {
    title: "Publish subscribed scheduled digest",
    description: "Publish one successfully completed scheduled-task digest to its explicitly subscribed Telegram group. Use one deterministic run_key per schedule occurrence; retries must reuse it. Each subscription is capped at one Telegram message per Asia/Shanghai calendar day.",
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
  }, async (input) => toolResult(() => operations.publish(token, input)));
  return server;
}

export function createCodexScheduledDeliveryMcpHttpHandler(operations: CodexScheduledDeliveryMcpOperations) {
  const requestGate = new CapabilityRequestGate();
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token || !(await operations.authorize(token))) {
      return Response.json({ error: "Scheduled delivery capability is invalid or revoked" }, { status: 401 });
    }
    const gate = requestGate.enter(token);
    if (!gate.accepted) {
      return Response.json({ error: "Scheduled delivery capability is temporarily rate limited" }, {
        status: 429,
        headers: { "retry-after": String(gate.retryAfterSeconds) },
      });
    }
    try {
      let boundedRequest: Request;
      try {
        boundedRequest = await readBoundedMcpRequest(request, MCP_REQUEST_LIMIT);
      } catch (error) {
        if (error instanceof McpRequestTooLargeError) {
          return Response.json({ error: error.message }, { status: 413 });
        }
        throw error;
      }
      const server = createCodexScheduledDeliveryMcpServer(operations, token);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try { return await transport.handleRequest(boundedRequest); }
      finally { await server.close(); }
    } finally {
      gate.release();
    }
  };
}

interface CapabilityGateState {
  windowStartedAt: number;
  attempts: number;
  inFlight: boolean;
}

class CapabilityRequestGate {
  private readonly states = new Map<string, CapabilityGateState>();

  enter(token: string):
    | { accepted: true; release: () => void }
    | { accepted: false; retryAfterSeconds: number } {
    const now = Date.now();
    for (const [key, state] of this.states) {
      if (!state.inFlight && now - state.windowStartedAt >= CAPABILITY_RATE_WINDOW_MS) this.states.delete(key);
    }
    const key = createHash("sha256").update(token).digest("hex");
    let state = this.states.get(key);
    if (!state || now - state.windowStartedAt >= CAPABILITY_RATE_WINDOW_MS) {
      state = { windowStartedAt: now, attempts: 0, inFlight: false };
      this.states.set(key, state);
    }
    if (state.inFlight) return { accepted: false, retryAfterSeconds: 1 };
    if (state.attempts >= CAPABILITY_RATE_LIMIT) {
      return {
        accepted: false,
        retryAfterSeconds: Math.max(1, Math.ceil(
          (CAPABILITY_RATE_WINDOW_MS - (now - state.windowStartedAt)) / 1_000,
        )),
      };
    }
    state.attempts += 1;
    state.inFlight = true;
    return {
      accepted: true,
      release: () => { state!.inFlight = false; },
    };
  }
}

async function toolResult(operation: () => unknown | Promise<unknown>) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: message }],
      structuredContent: { error: message },
      isError: true,
    };
  }
}
