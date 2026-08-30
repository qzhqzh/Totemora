export type CodexSupervisionMode = "observed" | "managed";
export type CodexHistoryMode = "legacy" | "paginated";

export type CodexSupervisorPhase =
  | "observed"
  | "aligning"
  | "executing"
  | "waiting_decision"
  | "waiting_approval"
  | "retry_wait"
  | "verifying"
  | "paused"
  | "completed"
  | "failed";

export interface CodexThreadRecord {
  thread_id: string;
  cwd: string;
  workplace_id?: string;
  title?: string;
  preview: string;
  source: unknown;
  app_status: string;
  app_updated_at: number;
  history_mode?: CodexHistoryMode;
  mode: CodexSupervisionMode;
  phase: CodexSupervisorPhase;
  goal_objective?: string;
  goal_status?: string;
  token_budget?: number;
  token_used: number;
  deadline_at?: string;
  turn_timeout_at?: string;
  current_turn_id?: string;
  last_turn_status?: string;
  infra_retries: number;
  strategy_attempts: number;
  next_action_at?: string;
  last_directive_at?: string;
  last_observed_at: string;
  managed_at?: string;
  completed_at?: string;
  last_error?: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type CodexDirectiveKind = "continue" | "steer" | "answer" | "checkpoint" | "verify";
export type CodexDirectiveStatus = "queued" | "leased" | "completed" | "failed" | "cancelled" | "uncertain";

export interface CodexDirective {
  id: string;
  thread_id: string;
  kind: CodexDirectiveKind;
  content: string;
  actor_id: string;
  channel: "supervisor" | "web" | "mcp" | "telegram";
  target_turn_id?: string;
  status: CodexDirectiveStatus;
  idempotency_key: string;
  attempts: number;
  lease_token?: string;
  lease_expires_at?: string;
  available_at: string;
  completed_at?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export type CodexInteractionKind = "fyi" | "suggest" | "decision" | "approval";
export type CodexInteractionStatus =
  | "open" | "answered" | "defaulted" | "expired" | "resolved" | "cancelled" | "manual_attention";

export interface CodexInteractionOption {
  id: string;
  label: string;
  description: string;
}

export interface CodexInteraction {
  id: string;
  thread_id: string;
  kind: CodexInteractionKind;
  status: CodexInteractionStatus;
  title: string;
  body: string;
  options: CodexInteractionOption[];
  recommendation_option_id?: string;
  default_option_id?: string;
  selected_option_id?: string;
  response_text?: string;
  source: "agent" | "app_server" | "supervisor" | "operator";
  server_method?: string;
  server_request_id?: string | number;
  connection_id?: string;
  params?: unknown;
  expires_at?: string;
  revision: number;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
}

export interface CodexLease {
  resource_type: "thread" | "worktree";
  resource_key: string;
  thread_id: string;
  owner_id: string;
  fencing_token: number;
  expires_at: string;
  acquired_at: string;
  updated_at: string;
}

export interface CodexSupervisorStatus {
  enabled: boolean;
  connected: boolean;
  connection_id?: string;
  socket_path: string;
  cli_version?: string;
  last_scan_at?: string;
  next_scan_at?: string;
  observed_threads: number;
  running_threads: number;
  managed_threads: number;
  active_managed_threads: number;
  open_interactions: number;
  phase_counts: Partial<Record<CodexSupervisorPhase, number>>;
  directive_counts: Partial<Record<CodexDirectiveStatus, number>>;
  open_interaction_counts: Partial<Record<CodexInteractionKind, number>>;
  last_error?: string;
}

export const DEFAULT_CODEX_TOKEN_BUDGET = 150_000;
export const CODEX_GOAL_OBJECTIVE_MAX_CHARS = 4_000;
export const DEFAULT_CODEX_DEADLINE_MS = 72 * 60 * 60 * 1_000;
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const CODEX_SUPERVISOR_MAX_CONCURRENCY = 2;
