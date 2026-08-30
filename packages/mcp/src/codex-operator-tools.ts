import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { TotemoraGatewayClient } from "./gateway-client";

export function registerCodexOperatorTools(server: McpServer, gateway: TotemoraGatewayClient): void {
  server.registerTool("totemora_codex_status", {
    title: "Inspect Codex supervisor",
    description: "Inspect the shared App Server connection, observed and managed task counts, decision inbox, and supervisor health.",
    annotations: readOnly("Inspect Codex supervisor"),
  }, async () => result(() => gateway.codexStatus()));
  server.registerTool("totemora_codex_list_threads", {
    title: "List observed Codex tasks",
    description: "List Codex tasks observed from the shared daemon. Listing does not opt a task into supervision.",
    inputSchema: {
      mode: z.enum(["observed", "managed"]).optional(),
      phase: z.enum(["observed", "aligning", "executing", "waiting_decision", "waiting_approval", "retry_wait", "verifying", "paused", "completed", "failed"]).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: readOnly("List observed Codex tasks"),
  }, async (input) => result(() => gateway.listCodexThreads(input)));
  server.registerTool("totemora_codex_get_thread", {
    title: "Inspect one Codex task",
    description: "Read a task snapshot, supervision policy, durable directives, and interaction history.",
    inputSchema: { thread_id: z.string().min(1).max(200) },
    annotations: readOnly("Inspect Codex task"),
  }, async ({ thread_id }) => result(() => gateway.getCodexThread(thread_id)));
  server.registerTool("totemora_codex_manage_thread", {
    title: "Manage a Codex goal",
    description: "Explicitly opt one observed task in to bounded supervision. The task must be inside a registered Workplace; this does not approve future side effects.",
    inputSchema: {
      thread_id: z.string().min(1).max(200),
      expected_revision: z.number().int().min(1),
      objective: z.string().min(1).max(10_000),
      token_budget: z.number().int().min(1).max(2_000_000).default(150_000),
      deadline_at: z.string().datetime().optional(),
    },
    annotations: writeAnnotations("Manage Codex goal"),
  }, async (input) => result(() => gateway.manageCodexThread(input)));
  server.registerTool("totemora_codex_pause_thread", {
    title: "Pause Codex supervision",
    description: "Pause future supervised turns without automatically interrupting the active turn.",
    inputSchema: revisionInput,
    annotations: writeAnnotations("Pause Codex supervision"),
  }, async (input) => result(() => gateway.pauseCodexThread(input.thread_id, input.expected_revision)));
  server.registerTool("totemora_codex_resume_thread", {
    title: "Resume Codex supervision",
    description: "Resume a paused managed goal under its existing budget, deadline, leases, and approval boundaries.",
    inputSchema: revisionInput,
    annotations: writeAnnotations("Resume Codex supervision"),
  }, async (input) => result(() => gateway.resumeCodexThread(input.thread_id, input.expected_revision)));
  server.registerTool("totemora_codex_stop_managing", {
    title: "Stop managing a Codex task",
    description: "Remove the task from Totemora supervision without interrupting its active turn or deleting App Server history.",
    inputSchema: revisionInput,
    annotations: writeAnnotations("Stop managing Codex task"),
  }, async (input) => result(() => gateway.stopManagingCodexThread(input.thread_id, input.expected_revision)));
  server.registerTool("totemora_codex_send_instruction", {
    title: "Send a Codex instruction",
    description: "Queue an idempotent instruction. Active tasks are steered with a turn-id precondition; idle tasks receive a new turn.",
    inputSchema: {
      thread_id: z.string().min(1).max(200),
      content: z.string().min(1).max(20_000),
      idempotency_key: z.string().min(1).max(200),
    },
    annotations: writeAnnotations("Send Codex instruction"),
  }, async (input) => result(() => gateway.sendCodexInstruction(input)));
  server.registerTool("totemora_codex_list_interactions", {
    title: "List Codex interactions",
    description: "Inspect FYIs, suggestions, decisions, and approvals. App Server approvals remain answerable only through the Web approval route.",
    inputSchema: {
      thread_id: z.string().min(1).max(200).optional(),
      status: z.enum(["open", "answered", "defaulted", "expired", "resolved", "cancelled", "manual_attention"]).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: readOnly("List Codex interactions"),
  }, async (input) => result(() => gateway.listCodexInteractions(input)));
  server.registerTool("totemora_codex_answer_interaction", {
    title: "Answer a Codex decision",
    description: "Answer a non-approval Codex suggestion or decision with an optimistic revision. System approvals are deliberately Web-only.",
    inputSchema: {
      interaction_id: z.string().min(1).max(200),
      expected_revision: z.number().int().min(1),
      selected_option_id: z.string().max(100).optional(),
      response_text: z.string().max(20_000).optional(),
    },
    annotations: writeAnnotations("Answer Codex decision"),
  }, async (input) => result(() => gateway.answerCodexInteraction(input)));
}

const revisionInput = {
  thread_id: z.string().min(1).max(200),
  expected_revision: z.number().int().min(1),
};

function readOnly(title: string) {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function writeAnnotations(title: string) {
  return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

async function result(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
      structuredContent: value as Record<string, unknown>,
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
