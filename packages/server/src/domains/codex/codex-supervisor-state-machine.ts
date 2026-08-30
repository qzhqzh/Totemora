import type {
  CodexInteraction,
  CodexSupervisorPhase,
  CodexThreadRecord,
} from "./codex-supervisor-types";

export type CodexReconcileAction =
  | "none"
  | "align"
  | "continue"
  | "continue_alternative"
  | "verify"
  | "complete"
  | "pause"
  | "retry_infrastructure"
  | "fail"
  | "wait_active"
  | "wait_decision"
  | "wait_approval";

export interface CodexReconcileDecision {
  action: CodexReconcileAction;
  phase: CodexSupervisorPhase;
  reason: string;
}

const TERMINAL_PHASES = new Set<CodexSupervisorPhase>(["observed", "paused", "completed", "failed"]);

export function evaluateCodexThread(
  thread: CodexThreadRecord,
  openInteractions: CodexInteraction[],
  now = new Date(),
): CodexReconcileDecision {
  if (thread.mode !== "managed" || TERMINAL_PHASES.has(thread.phase)) {
    return decision("none", thread.phase, "thread is not eligible for automatic supervision");
  }
  if (thread.history_mode === "paginated") {
    return decision("pause", "paused", "paginated history cannot be resumed by the current Codex App Server");
  }
  if (!thread.workplace_id) return decision("pause", "paused", "thread is outside every registered Workplace");
  if (thread.deadline_at && Date.parse(thread.deadline_at) <= now.getTime()) {
    return decision("pause", "paused", "supervision deadline reached");
  }
  if (
    (thread.token_budget !== undefined && thread.token_used >= thread.token_budget)
    || thread.goal_status === "budgetLimited"
    || thread.goal_status === "usageLimited"
  ) {
    return decision("pause", "paused", "goal token or account usage budget reached");
  }
  const approval = openInteractions.find((interaction) => interaction.kind === "approval");
  if (approval) return decision("wait_approval", "waiting_approval", `approval ${approval.id} requires the operator`);
  const choice = openInteractions.find((interaction) => interaction.kind === "decision" || interaction.kind === "suggest");
  if (choice) return decision("wait_decision", "waiting_decision", `interaction ${choice.id} requires resolution`);
  if (thread.goal_status === "paused" || thread.goal_status === "blocked") {
    return decision("wait_decision", "waiting_decision", `Codex goal is ${thread.goal_status}`);
  }
  if (thread.last_turn_status === "interrupted") {
    return decision("pause", "paused", "the active turn was interrupted outside the supervisor");
  }
  if (thread.turn_timeout_at && Date.parse(thread.turn_timeout_at) <= now.getTime()) {
    return decision("pause", "paused", "turn supervision timeout reached; the turn was not interrupted automatically");
  }
  if (thread.current_turn_id) return decision("wait_active", thread.phase, "the supervisor is tracking an active turn");
  if (thread.phase === "retry_wait" && thread.next_action_at && Date.parse(thread.next_action_at) > now.getTime()) {
    return decision("none", thread.phase, "infrastructure retry backoff has not elapsed");
  }
  if (thread.app_status === "systemError") {
    return thread.infra_retries < 3
      ? decision("retry_infrastructure", "retry_wait", "Codex reported a system error")
      : decision("fail", "failed", "infrastructure retry limit reached");
  }
  if (thread.phase === "retry_wait") {
    return decision("align", "aligning", "infrastructure retry backoff elapsed");
  }
  if (thread.app_status === "active") return decision("wait_active", thread.phase, "the current turn is still active");
  if (thread.phase === "aligning" || !thread.goal_status) {
    return decision("align", "aligning", "managed goal must be aligned with App Server state");
  }
  if (thread.goal_status === "complete") {
    if (thread.phase === "verifying" && thread.last_turn_status === "completed") {
      return decision("complete", "completed", "verification turn completed");
    }
    return decision("verify", "verifying", "goal reports complete and requires an independent verification turn");
  }
  if (thread.last_turn_status === "failed") {
    return thread.strategy_attempts < 5
      ? decision("continue_alternative", "executing", "agent turn failed; request an alternative strategy")
      : decision("fail", "failed", "alternative strategy limit reached");
  }
  if (thread.app_status === "idle" || thread.app_status === "notLoaded") {
    if (
      (thread.next_action_at && Date.parse(thread.next_action_at) > now.getTime())
      || (thread.last_directive_at && now.getTime() - Date.parse(thread.last_directive_at) < 5_000)
    ) {
      return decision("none", thread.phase, "auto-continue cooldown has not elapsed");
    }
    return decision("continue", "executing", "managed active goal is idle");
  }
  return decision("none", thread.phase, `unsupported App Server status ${thread.app_status}`);
}

function decision(action: CodexReconcileAction, phase: CodexSupervisorPhase, reason: string): CodexReconcileDecision {
  return { action, phase, reason };
}
