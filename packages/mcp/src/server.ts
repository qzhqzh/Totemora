import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { TotemoraGatewayClient, type DevelopmentProposalSummary } from "./gateway-client";

const capabilityText = [
  "Totemora exposes one persistent Git Flow capability, not a collection of raw GitHub commands.",
  "An MCP host starts one delegated workflow and receives a task_id. The Chief routes it to a qualified tribe member, accepts the member report, and returns durable evidence.",
  "The Git Flow specialist can prepare a local Commit, publish an Issue and Pull Request, review the PR, and merge to the Workplace target branch when policy and explicit gates allow it.",
  "Remote writes are disabled unless the saved Workplace Policy enables them. Force push and arbitrary shell execution are never exposed.",
].join("\n");

export function createTotemoraMcpServer(gateway: TotemoraGatewayClient): McpServer {
  const server = new McpServer({ name: "totemora-tribe", version: "0.6.0-living-tribe" }, {
    instructions: "Discover tribe assets and members, talk to a specialist with optional mentor escalation, run the intelligence watch, or delegate a gated Git management outcome.",
  });

  server.registerResource("totemora-capabilities", "totemora://capabilities", {
    title: "Totemora tribe capabilities",
    description: "Stable service capabilities and their safety boundaries.",
    mimeType: "text/plain",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: capabilityText }] }));

  server.registerTool("totemora_status", {
    title: "Inspect Totemora tribe",
    description: "Check whether the persistent Totemora Gateway is online and inspect its members and enabled capabilities.",
    annotations: readOnlyAnnotations("Inspect Totemora tribe"),
  }, async () => toolCall(() => gateway.status()));

  server.registerTool("totemora_list_workplaces", {
    title: "List Totemora workplaces",
    description: "List registered project workplaces and their Git Flow policies.",
    annotations: readOnlyAnnotations("List Totemora workplaces"),
  }, async () => toolCall(() => gateway.listWorkplaces()));

  server.registerTool("totemora_list_assets", {
    title: "List Totemora tribe assets",
    description: "Discover deterministic tools, adapters, infrastructure and knowledge owned by the tribe, including member grants, maturity, policy requirements and verified evidence.",
    annotations: readOnlyAnnotations("List tribe assets"),
  }, async () => toolCall(() => gateway.listAssets()));

  server.registerTool("totemora_list_services", {
    title: "List Totemora professional services",
    description: "Discover the tribe's typed long-lived services, allowed operations, risk level, acceptance policy, assigned specialist and tool grants.",
    annotations: readOnlyAnnotations("List professional services"),
  }, async () => toolCall(() => gateway.listServices()));

  server.registerTool("totemora_list_members", {
    title: "List living tribe members",
    description: "Inspect member identity, lineage, mentor, verified and failed experiences, vitality, growth evidence and current rank.",
    annotations: readOnlyAnnotations("List living tribe members"),
  }, async () => toolCall(() => gateway.listMemberDossiers()));

  server.registerTool("totemora_get_member", {
    title: "Inspect one tribe member",
    description: "Read one member's personality, lineage, abilities, life stage, growth signals and recent experiences.",
    inputSchema: { member_id: z.string().min(1) },
    annotations: readOnlyAnnotations("Inspect tribe member"),
  }, async ({ member_id }) => toolCall(() => gateway.getMemberDossier(member_id)));

  server.registerTool("totemora_chat_with_member", {
    title: "Talk to a tribe member",
    description: "Send a message to one persistent member. The member sees its own experience and can optionally ask its configured mentor for guidance before answering.",
    inputSchema: {
      member_id: z.string().min(1), message: z.string().min(1).max(8_000),
      ask_mentor: z.boolean().default(false),
    },
    annotations: { title: "Talk to member", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ member_id, message, ask_mentor }) => toolCall(() => gateway.chatWithMember(member_id, message, ask_mentor)));

  server.registerTool("totemora_list_intelligence_briefs", {
    title: "List tribe intelligence briefs",
    description: "Inspect recent scheduled or manually requested briefs and configured notification-channel evidence.",
    annotations: readOnlyAnnotations("List intelligence briefs"),
  }, async () => toolCall(() => gateway.listIntelligenceBriefs()));

  server.registerTool("totemora_list_intelligence_candidates", {
    title: "Inspect intelligence candidate pool",
    description: "Inspect queued, suppressed, sending, sent and failed intelligence candidates with deterministic value scores and deduplication reasons.",
    annotations: readOnlyAnnotations("Inspect intelligence candidate pool"),
  }, async () => toolCall(() => gateway.listIntelligenceCandidates()));

  server.registerTool("totemora_list_actions", {
    title: "Inspect tribe action journal",
    description: "Inspect recent external side effects, idempotency keys, attempts, outcomes and bounded evidence. Requires the MCP operator credential.",
    annotations: readOnlyAnnotations("Inspect action journal"),
  }, async () => toolCall(() => gateway.listActions()));

  server.registerTool("totemora_run_intelligence_brief", {
    title: "Run the tribe intelligence watch",
    description: "Queue a durable scan for Qwen-seeded intelligence member 听风. By default results enter the scored, deduplicated candidate pool and the resident dispatcher fans out at most one candidate per configured interval to Bark and Telegram. Direct push is an explicit compatibility mode.",
    inputSchema: {
      message_count: z.number().int().min(1).max(5).default(1),
      idempotency_key: z.string().min(1).max(200).optional(),
      delivery_mode: z.enum(["candidate_pool", "direct_push"]).default("candidate_pool"),
    },
    annotations: { title: "Run intelligence watch", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_count, idempotency_key, delivery_mode }) => toolCall(() => gateway.runIntelligenceBrief(message_count, idempotency_key, delivery_mode)));

  server.registerTool("totemora_get_intelligence_task", {
    title: "Get an intelligence task",
    description: "Poll a durable intelligence task until it completes with candidate-pool decisions or direct notification evidence, or fails with a retryable reason.",
    inputSchema: { task_id: z.string().min(1) },
    annotations: readOnlyAnnotations("Get intelligence task"),
  }, async ({ task_id }) => toolCall(() => gateway.getIntelligenceTask(task_id)));

  server.registerTool("totemora_start_git_flow", {
    title: "Delegate a Git Flow outcome to the tribe",
    description: "Starts one durable tribe workflow. The Chief routes the goal to a Git specialist and returns a task_id immediately. Modes stop after local Commit, reviewed Pull Request, or Merge.",
    inputSchema: {
      workplace_id: z.string().min(1).describe("Registered Totemora workplace id"),
      goal: z.string().min(1).describe("Desired Git management outcome and scope"),
      mode: z.enum(["commit", "pull_request", "merge"]).default("commit"),
      issue_mode: z.enum(["auto", "none"]).default("none"),
    },
    annotations: { title: "Delegate Git Flow", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ workplace_id, goal, mode, issue_mode }) => toolCall(() =>
    gateway.startGitFlow(workplace_id, goal, mode, issue_mode),
  ));

  server.registerTool("totemora_get_task", {
    title: "Get a Totemora specialist task",
    description: "Inspect the shared durable envelope for a Git Flow or intelligence specialist task, including member assignment, stage, revision and domain result reference.",
    inputSchema: { task_id: z.string().min(1) },
    annotations: readOnlyAnnotations("Get specialist task"),
  }, async ({ task_id }) => toolCall(() => gateway.getSpecialistTask(task_id)));

  server.registerTool("totemora_list_git_flows", {
    title: "List Git Flow workflows",
    description: "List recent durable Git Flow workflows and their current gates.",
    annotations: readOnlyAnnotations("List Git Flow workflows"),
  }, async () => toolCall(() => gateway.listGitCommitProposals()));

  server.registerTool("totemora_get_git_flow", {
    title: "Inspect a Git Flow workflow",
    description: "Inspect Chief assignment, specialist self-check, exact files, validation, remote plan, PR review, current gate, and final report.",
    inputSchema: { workflow_id: z.string().min(1) },
    annotations: readOnlyAnnotations("Inspect Git Flow workflow"),
  }, async ({ workflow_id }) => toolCall(() => gateway.getGitCommitProposal(workflow_id)));

  server.registerTool("totemora_advance_git_flow", {
    title: "Approve the current Git Flow gate",
    description: "Advances the same workflow through its local, remote, or merge gate. The expected status, snapshot and Commit message prevent approving stale or unseen work.",
    inputSchema: {
      workflow_id: z.string().min(1),
      gate: z.enum(["local", "remote", "merge"]),
      expected_status: z.string().min(1),
      expected_snapshot_hash: z.string().min(1),
      expected_commit_message: z.string().min(1),
      confirmation: z.literal("APPROVE_GIT_FLOW_STAGE"),
    },
    annotations: { title: "Approve Git Flow gate", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ workflow_id, gate, expected_status, expected_snapshot_hash, expected_commit_message }) => toolCall(async () => {
    const workflow = await gateway.getGitCommitProposal(workflow_id);
    assertGateMatches(workflow, gate, expected_status, expected_snapshot_hash, expected_commit_message);
    return gateway.advanceGitFlow(workflow_id, gate);
  }));

  return server;
}

function readOnlyAnnotations(title: string) {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function assertGateMatches(
  workflow: DevelopmentProposalSummary,
  gate: "local" | "remote" | "merge",
  status: string,
  snapshotHash: string,
  commitMessage: string,
): void {
  const expectedByGate = {
    local: "awaiting_approval",
    remote: "awaiting_remote_approval",
    merge: "awaiting_merge_approval",
  } as const;
  if (workflow.status !== status || status !== expectedByGate[gate]) throw new Error("Workflow is not at the approved gate");
  if (workflow.snapshot_hash !== snapshotHash) throw new Error("Expected snapshot hash does not match the inspected workflow");
  if (workflow.commit_message !== commitMessage) throw new Error("Expected Commit message does not match the inspected workflow");
  if (workflow.self_check.outcome !== "accepted" || workflow.chief_acceptance.outcome !== "accepted") {
    throw new Error("The specialist and Chief have not accepted this workflow stage");
  }
}

async function toolCall(operation: () => Promise<unknown>) {
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
