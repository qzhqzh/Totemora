import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { totemoraProductVersion } from "@totemora/core";

import { McpRequestTooLargeError, readBoundedMcpRequest } from "./bounded-mcp-request";

const MCP_REQUEST_LIMIT = 64 * 1_024;

export interface CodexAgentMcpOperations {
  authorize(token: string): boolean | Promise<boolean>;
  raiseInteraction(token: string, input: {
    kind: "fyi" | "suggest" | "decision" | "approval";
    title: string;
    body: string;
    options?: Array<{ id: string; label: string; description: string }>;
    recommendation_option_id?: string;
    default_option_id?: string;
    expires_at?: string;
  }): unknown | Promise<unknown>;
  reportCheckpoint(token: string, input: {
    summary: string;
    evidence: string[];
    remaining_work: string[];
    next_step?: string;
    outcome: "progress" | "blocked" | "ready_for_verification";
  }): unknown | Promise<unknown>;
}

const interactionOption = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  description: z.string().max(1_000),
});

export function createCodexAgentMcpServer(operations: CodexAgentMcpOperations, token: string): McpServer {
  const server = new McpServer({ name: "totemora-codex-agent", version: totemoraProductVersion() }, {
    instructions: "This restricted profile can only report a checkpoint or raise an owner interaction for the current managed Codex turn. It cannot manage tasks, answer interactions, or approve actions.",
  });
  server.registerTool("codex_raise_interaction", {
    title: "Raise a supervised Codex interaction",
    description: "Raise an FYI, reversible suggestion, owner decision, or concrete approval request for the current managed turn. This tool cannot answer or approve the request.",
    inputSchema: {
      kind: z.enum(["fyi", "suggest", "decision", "approval"]),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(10_000),
      options: z.array(interactionOption).max(3).optional(),
      recommendation_option_id: z.string().max(100).optional(),
      default_option_id: z.string().max(100).optional(),
      expires_at: z.string().datetime().optional(),
    },
    annotations: { title: "Raise interaction", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => toolResult(() => operations.raiseInteraction(token, input)));
  server.registerTool("codex_report_checkpoint", {
    title: "Report a supervised Codex checkpoint",
    description: "Persist bounded progress, validation evidence, remaining work, and the next step for the current managed turn. Final completion remains the supervisor's decision.",
    inputSchema: {
      summary: z.string().min(1).max(4_000),
      evidence: z.array(z.string().min(1).max(2_000)).max(20),
      remaining_work: z.array(z.string().min(1).max(2_000)).max(20),
      next_step: z.string().max(4_000).optional(),
      outcome: z.enum(["progress", "blocked", "ready_for_verification"]),
    },
    annotations: { title: "Report checkpoint", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => toolResult(() => operations.reportCheckpoint(token, input)));
  return server;
}

export function createCodexAgentMcpHttpHandler(operations: CodexAgentMcpOperations) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token || !(await operations.authorize(token))) {
      return Response.json({ error: "Codex agent capability is invalid or expired" }, { status: 401 });
    }
    let boundedRequest: Request;
    try {
      boundedRequest = await readBoundedMcpRequest(request, MCP_REQUEST_LIMIT);
    } catch (error) {
      if (error instanceof McpRequestTooLargeError) {
        return Response.json({ error: error.message }, { status: 413 });
      }
      throw error;
    }
    const server = createCodexAgentMcpServer(operations, token);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try { return await transport.handleRequest(boundedRequest); }
    finally { await server.close(); }
  };
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
