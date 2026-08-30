import type { CodexAppServerClient, CodexServerNotification, CodexServerRequest } from "../integrations/codex-app-server-client";
import {
  CODEX_GOAL_OBJECTIVE_MAX_CHARS, DEFAULT_CODEX_DEADLINE_MS, DEFAULT_CODEX_TOKEN_BUDGET,
  type CodexInteraction, type CodexInteractionKind, type CodexInteractionOption,
  type CodexSupervisorStatus, type CodexThreadRecord,
} from "../domains/codex/codex-supervisor-types";
import { CodexAgentCapabilityRepository } from "../repositories/codex-agent-capability-repository";
import { CodexDirectiveRepository } from "../repositories/codex-directive-repository";
import { CodexInteractionRepository } from "../repositories/codex-interaction-repository";
import { CodexThreadRepository } from "../repositories/codex-thread-repository";
import { SpecialistTaskRepository } from "../specialist-service";
import { CodexInteractionBridge } from "./codex-interaction-bridge";
import { CodexSupervisorReconciler } from "./codex-supervisor-reconciler";
import { CodexSupervisorEventHandler } from "./codex-supervisor-event-handler";
import { CodexThreadObserver } from "./codex-thread-observer";

export class CodexSupervisorUnavailableError extends Error {}
export class CodexThreadUnmanageableError extends Error {}
export interface ManageCodexThreadInput {
  thread_id: string; expected_revision: number; objective: string;
  token_budget?: number; deadline_at?: string;
  trigger?: "web" | "mcp";
}

export class CodexSupervisorService {
  private readonly threads: CodexThreadRepository;
  private readonly directives: CodexDirectiveRepository;
  private readonly interactions: CodexInteractionRepository;
  private readonly capabilities: CodexAgentCapabilityRepository;
  private readonly specialistTasks: SpecialistTaskRepository;
  private readonly bridge: CodexInteractionBridge;
  private readonly reconciler: CodexSupervisorReconciler;
  private readonly events: CodexSupervisorEventHandler;
  private client: CodexAppServerClient | undefined;
  private connectionId: string | undefined;
  private lastScanAt: string | undefined;
  private nextScanAt: string | undefined;
  private lastError: string | undefined;
  private cliVersion: string | undefined;
  private activeScan: Promise<void> | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly socketPath: string,
    private readonly enabled: boolean,
    ownerId = `codex-supervisor:${crypto.randomUUID()}`,
    private readonly now: () => Date = () => new Date(),
    agentMcpUrl?: string,
  ) {
    this.threads = new CodexThreadRepository(dataDir);
    this.directives = new CodexDirectiveRepository(dataDir);
    this.interactions = new CodexInteractionRepository(dataDir);
    this.capabilities = new CodexAgentCapabilityRepository(dataDir);
    this.specialistTasks = new SpecialistTaskRepository(dataDir);
    this.bridge = new CodexInteractionBridge(dataDir);
    this.reconciler = new CodexSupervisorReconciler(dataDir, ownerId, now, agentMcpUrl);
    this.events = new CodexSupervisorEventHandler(dataDir, this.reconciler, now);
  }

  attachConnection(client: CodexAppServerClient, connectionId: string): void {
    this.client = client;
    this.connectionId = connectionId;
    this.cliVersion = (client as CodexAppServerClient & { getServerVersion?: () => string | undefined }).getServerVersion?.();
    this.lastError = undefined;
  }

  detachConnection(connectionId: string, error?: Error): void {
    if (this.connectionId !== connectionId) return;
    this.interactions.markConnectionLost(connectionId);
    this.client = undefined;
    this.connectionId = undefined;
    this.lastError = error?.message ?? "Codex App Server disconnected";
  }

  async scan(): Promise<void> {
    if (this.activeScan) return this.activeScan;
    const scan = this.performScan();
    this.activeScan = scan;
    try {
      await scan;
    } finally {
      if (this.activeScan === scan) this.activeScan = undefined;
    }
  }

  private async performScan(): Promise<void> {
    const client = this.requireClient();
    const result = await new CodexThreadObserver(client, this.dataDir).scan();
    this.lastScanAt = result.scanned_at;
    this.lastError = undefined;
  }

  async cycle(): Promise<void> {
    if (!this.enabled || !this.client) return;
    this.interactions.applyExpired(this.now().toISOString());
    await this.applyDefaultedSuggestions();
    this.directives.markExpiredLeasesUncertain(this.now().toISOString());
    this.capabilities.pruneExpired(this.now().toISOString());
    await this.reconciler.reconcileAll(this.client);
  }

  async manageThread(input: ManageCodexThreadInput): Promise<CodexThreadRecord> {
    this.requireClient();
    const objective = input.objective.trim();
    if (!objective || objective.length > CODEX_GOAL_OBJECTIVE_MAX_CHARS) {
      throw new Error(`Codex goal objective must contain 1-${CODEX_GOAL_OBJECTIVE_MAX_CHARS} characters`);
    }
    const tokenBudget = input.token_budget ?? DEFAULT_CODEX_TOKEN_BUDGET;
    if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 2_000_000) throw new Error("Invalid Codex token budget");
    const deadline = input.deadline_at ? new Date(input.deadline_at) : new Date(this.now().getTime() + DEFAULT_CODEX_DEADLINE_MS);
    if (!Number.isFinite(deadline.getTime()) || deadline <= this.now() || deadline.getTime() > this.now().getTime() + 30 * 24 * 60 * 60_000) {
      throw new Error("Codex deadline must be in the next 30 days");
    }
    const current = this.threads.getRequired(input.thread_id);
    assertManageableHistory(current);
    if (!current.workplace_id) throw new Error("Codex thread is outside every registered Workplace");
    const managed = this.threads.manage({
      thread_id: input.thread_id,
      expected_revision: input.expected_revision,
      workplace_id: current.workplace_id,
      objective,
      token_budget: tokenBudget,
      deadline_at: deadline.toISOString(),
      now: this.now().toISOString(),
    });
    if (!this.specialistTasks.findByResultRef("codex.supervisor", input.thread_id)) {
      this.specialistTasks.create({
        id: crypto.randomUUID(), service_id: "codex.supervisor", service_version: 1,
        operation: "supervise_goal", trigger: input.trigger ?? "web", status: "queued",
        current_stage: "observe", idempotency_key: `codex-supervisor:${input.thread_id}`,
        input: { thread_id: input.thread_id, objective, token_budget: tokenBudget, deadline_at: deadline.toISOString() },
        result_ref: input.thread_id,
      });
    }
    return managed;
  }

  async pauseThread(threadId: string, expectedRevision: number): Promise<CodexThreadRecord> {
    const client = this.requireClient();
    await client.setGoal(threadId, { status: "paused" });
    this.directives.cancelQueued(threadId);
    const paused = this.threads.updateControl(threadId, expectedRevision, {
      phase: "paused", goal_status: "paused", next_action_at: null,
    });
    this.reconciler.releaseThread(threadId);
    return paused;
  }

  async resumeThread(threadId: string, expectedRevision: number): Promise<CodexThreadRecord> {
    const client = this.requireClient();
    const current = this.threads.getRequired(threadId);
    if (current.revision !== expectedRevision) throw new Error(`Codex thread revision conflict: ${threadId}`);
    if (current.mode !== "managed") throw new Error("Codex thread is not managed");
    assertManageableHistory(current);
    if (!current.goal_objective || current.token_budget === undefined) {
      throw new Error("Managed Codex thread has no recoverable goal definition");
    }
    await client.resumeManagedThread(threadId, { cwd: current.cwd });
    await client.setGoal(threadId, {
      objective: current.goal_objective,
      status: "active",
      tokenBudget: current.token_budget,
    });
    return this.threads.updateControl(threadId, expectedRevision, {
      phase: "aligning", goal_status: "active", next_action_at: this.now().toISOString(),
      last_turn_status: null, last_error: null,
    });
  }

  stopManaging(threadId: string, expectedRevision: number): CodexThreadRecord {
    this.directives.cancelQueued(threadId);
    this.reconciler.releaseThread(threadId);
    return this.threads.unmanage(threadId, expectedRevision);
  }

  sendInstruction(input: {
    thread_id: string;
    content: string;
    actor_id: string;
    channel: "web" | "mcp";
    idempotency_key: string;
  }) {
    this.requireClient();
    const thread = this.threads.getRequired(input.thread_id);
    if (thread.mode !== "managed") throw new Error("Codex thread is not managed");
    assertManageableHistory(thread);
    return this.directives.enqueue({
      ...input,
      kind: thread.current_turn_id ? "steer" : "continue",
      target_turn_id: thread.current_turn_id,
    });
  }

  async answerInteraction(input: {
    id: string; expected_revision: number;
    selected_option_id?: string; response_text?: string;
    actor_id?: string; channel?: "web" | "mcp" | "telegram";
  }): Promise<CodexInteraction> {
    const client = this.requireClient();
    const current = this.interactions.get(input.id);
    if (!current) throw new Error(`Codex interaction not found: ${input.id}`);
    if (current.server_request_id) {
      if (!this.connectionId) throw new CodexSupervisorUnavailableError("Codex App Server is unavailable");
      return this.bridge.answerServerInteraction(input, this.connectionId, client);
    }
    const answered = this.interactions.answer(input);
    await this.applyLocalAnswer(answered, input.actor_id, input.channel);
    return this.interactions.get(input.id)!;
  }

  raiseAgentInteraction(token: string, input: {
    kind: CodexInteractionKind;
    title: string;
    body: string;
    options?: CodexInteractionOption[];
    recommendation_option_id?: string;
    default_option_id?: string;
    expires_at?: string;
  }): CodexInteraction {
    const capability = this.requireCapability(token);
    const thread = this.threads.getRequired(capability.thread_id);
    if (thread.current_turn_id !== capability.turn_id) throw new Error("Codex capability is not bound to the active turn");
    const expiresAt = input.kind === "suggest"
      ? input.expires_at ?? new Date(this.now().getTime() + 2 * 60 * 60_000).toISOString()
      : input.expires_at;
    return this.interactions.create({
      thread_id: capability.thread_id, ...input, expires_at: expiresAt, source: "agent",
    });
  }

  reportAgentCheckpoint(token: string, input: {
    summary: string;
    evidence: string[];
    remaining_work: string[];
    next_step?: string;
    outcome: "progress" | "blocked" | "ready_for_verification";
  }): CodexInteraction {
    const capability = this.requireCapability(token);
    if (this.threads.getRequired(capability.thread_id).current_turn_id !== capability.turn_id) {
      throw new Error("Codex capability is not bound to the active turn");
    }
    const body = JSON.stringify(input);
    if (body.length > 20_000) throw new Error("Codex checkpoint exceeds 20000 characters");
    const checkpoint = this.interactions.create({
      thread_id: capability.thread_id, kind: "fyi", title: `Checkpoint: ${input.outcome}`,
      body, source: "agent",
    });
    return this.interactions.resolve(checkpoint.id, checkpoint.revision);
  }

  handleNotification(notification: CodexServerNotification, connectionId: string): void {
    if (connectionId !== this.connectionId) return;
    this.events.handle(notification);
  }

  handleServerRequest(request: CodexServerRequest, connectionId: string): void {
    if (connectionId !== this.connectionId || !this.client) return;
    this.bridge.handleServerRequest(request, connectionId, this.client);
  }

  listThreads(input: Parameters<CodexThreadRepository["list"]>[0] = {}): CodexThreadRecord[] {
    return this.threads.list(input);
  }

  getThread(threadId: string): { thread: CodexThreadRecord; directives: unknown[]; interactions: CodexInteraction[] } {
    return {
      thread: this.threads.getRequired(threadId),
      directives: this.directives.list(threadId),
      interactions: this.interactions.list({ thread_id: threadId, limit: 100 }),
    };
  }

  listInteractions(input: Parameters<CodexInteractionRepository["list"]>[0] = {}): CodexInteraction[] {
    return this.interactions.list(input);
  }

  getStatus(): CodexSupervisorStatus {
    const counts = this.threads.counts();
    return {
      enabled: this.enabled, connected: Boolean(this.client), connection_id: this.connectionId,
      socket_path: this.socketPath, last_scan_at: this.lastScanAt, next_scan_at: this.nextScanAt, cli_version: this.cliVersion,
      observed_threads: counts.observed, running_threads: counts.running, managed_threads: counts.managed,
      active_managed_threads: counts.active_managed, open_interactions: this.interactions.countOpen(),
      phase_counts: this.threads.phaseCounts(), directive_counts: this.directives.counts(), open_interaction_counts: this.interactions.openCounts(),
      last_error: this.lastError,
    };
  }

  setNextScanAt(value: string | undefined): void { this.nextScanAt = value; }
  setRuntimeError(error: unknown): void { this.lastError = error instanceof Error ? error.message : String(error); }
  authorizeAgentToken(token: string): boolean { return Boolean(this.capabilities.verify(token)); }

  private async applyLocalAnswer(interaction: CodexInteraction, actorId = "operator", channel: "supervisor" | "web" | "mcp" | "telegram" = "web"): Promise<void> {
    const thread = this.threads.getRequired(interaction.thread_id);
    if (interaction.selected_option_id === "pause") {
      await this.pauseThread(thread.thread_id, thread.revision);
    } else if (interaction.selected_option_id === "resume") {
      await this.resumeThread(thread.thread_id, thread.revision);
    } else if (interaction.kind !== "fyi") {
      const selected = interaction.options.find((option) => option.id === interaction.selected_option_id);
      this.directives.enqueue({
        thread_id: thread.thread_id, kind: "answer",
        content: `Operator response: ${selected?.label ?? interaction.response_text ?? "acknowledged"}`,
        actor_id: actorId, channel, idempotency_key: `interaction:${interaction.id}`,
      });
      const latestThread = this.threads.getRequired(thread.thread_id);
      this.threads.updateControl(thread.thread_id, latestThread.revision, { phase: "executing", last_error: null });
    }
    const latest = this.interactions.get(interaction.id)!;
    this.interactions.resolve(latest.id, latest.revision);
  }

  private async applyDefaultedSuggestions(): Promise<void> {
    for (const interaction of this.interactions.list({ status: "defaulted", limit: 500 })) {
      try { await this.applyLocalAnswer(interaction, "codex-supervisor", "supervisor"); } catch (error) { this.setRuntimeError(error); }
    }
  }

  private requireCapability(token: string) {
    const capability = this.capabilities.verify(token);
    if (!capability) throw new Error("Invalid or expired Codex agent capability");
    return capability;
  }

  private requireClient(): CodexAppServerClient {
    if (!this.enabled || !this.client) throw new CodexSupervisorUnavailableError("Codex supervisor is disabled or disconnected");
    return this.client;
  }
}

function assertManageableHistory(thread: CodexThreadRecord): void {
  if (thread.history_mode === "paginated") {
    throw new CodexThreadUnmanageableError(
      "Codex thread uses paginated history and cannot be resumed by the current App Server; keep it observed or start a new thread",
    );
  }
}
