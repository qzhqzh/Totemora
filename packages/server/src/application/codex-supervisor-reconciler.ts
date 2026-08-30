import type { CodexAppServerClient } from "../integrations/codex-app-server-client";
import { evaluateCodexThread, type CodexReconcileDecision } from "../domains/codex/codex-supervisor-state-machine";
import type { CodexThreadRecord } from "../domains/codex/codex-supervisor-types";
import { CodexDirectiveRepository } from "../repositories/codex-directive-repository";
import { CodexInteractionRepository } from "../repositories/codex-interaction-repository";
import { CodexThreadRepository, type ThreadControlPatch } from "../repositories/codex-thread-repository";
import { CodexDirectiveDispatcher } from "./codex-directive-dispatcher";

const INFRASTRUCTURE_BACKOFF_MS = [15_000, 60_000, 5 * 60_000] as const;

export class CodexSupervisorReconciler {
  private readonly threads: CodexThreadRepository;
  private readonly directives: CodexDirectiveRepository;
  private readonly interactions: CodexInteractionRepository;
  private readonly dispatcher: CodexDirectiveDispatcher;

  constructor(
    dataDir: string,
    private readonly ownerId: string,
    private readonly now: () => Date = () => new Date(),
    agentMcpUrl?: string,
  ) {
    this.threads = new CodexThreadRepository(dataDir);
    this.directives = new CodexDirectiveRepository(dataDir);
    this.interactions = new CodexInteractionRepository(dataDir);
    this.dispatcher = new CodexDirectiveDispatcher(dataDir, ownerId, now, agentMcpUrl);
  }

  async reconcileAll(client: CodexAppServerClient): Promise<void> {
    for (let offset = 0; ; offset += 500) {
      const page = this.threads.list({ mode: "managed", limit: 500, offset });
      for (const thread of page) await this.reconcileThread(client, thread);
      if (page.length < 500) break;
    }
    await this.dispatcher.dispatchQueued(client);
  }

  releaseThread(threadId: string): void {
    this.dispatcher.releaseThread(threadId);
  }

  private async reconcileThread(client: CodexAppServerClient, thread: CodexThreadRecord): Promise<void> {
    const open = this.interactions.list({ thread_id: thread.thread_id, status: "open", limit: 20 });
    const decision = evaluateCodexThread(thread, open, this.now());
    if (this.directives.hasPending(thread.thread_id) && !["pause", "fail", "complete"].includes(decision.action)) return;
    switch (decision.action) {
      case "none":
        return;
      case "wait_active":
        await this.dispatcher.renewActiveLease(thread);
        return;
      case "wait_decision":
        if (!open.length && thread.goal_status === "blocked") {
          this.interactions.create({
            thread_id: thread.thread_id,
            kind: "decision",
            title: "Codex goal is blocked",
            body: "Choose whether the supervisor should resume with a new strategy or remain paused.",
            options: [
              { id: "resume", label: "Resume", description: "Ask Codex to try a materially different strategy." },
              { id: "pause", label: "Pause", description: "Keep supervision paused until a new instruction arrives." },
            ],
            recommendation_option_id: "pause",
            source: "supervisor",
          });
        }
        this.transition(thread, { phase: decision.phase });
        return;
      case "wait_approval":
        this.transition(thread, { phase: decision.phase });
        return;
      case "pause":
        await this.pause(client, thread, decision.reason);
        return;
      case "fail":
        this.transition(thread, { phase: "failed", completed_at: this.now().toISOString(), last_error: decision.reason });
        this.releaseThread(thread.thread_id);
        return;
      case "complete":
        this.transition(thread, { phase: "completed", completed_at: this.now().toISOString(), last_error: null });
        this.releaseThread(thread.thread_id);
        return;
      case "retry_infrastructure":
        this.scheduleInfrastructureRetry(thread, decision.reason);
        return;
      case "align":
        await this.align(client, thread);
        return;
      case "continue":
      case "continue_alternative":
      case "verify":
        this.queueDirective(thread, decision);
        return;
    }
  }

  private async align(client: CodexAppServerClient, thread: CodexThreadRecord): Promise<void> {
    try {
      await client.resumeManagedThread(thread.thread_id, { cwd: thread.cwd });
      const goal = await client.getGoal(thread.thread_id);
      if (
        !goal
        || goal.objective !== thread.goal_objective
        || goal.status !== "active"
        || goal.tokenBudget !== thread.token_budget
      ) {
        await client.setGoal(thread.thread_id, {
          objective: thread.goal_objective,
          status: "active",
          tokenBudget: thread.token_budget,
        });
      }
      this.queueDirective(thread, { action: "continue", phase: "executing", reason: "initial managed continuation" });
      this.transition(this.threads.getRequired(thread.thread_id), {
        phase: "executing", goal_status: "active", infra_retries: 0, next_action_at: null, last_error: null,
      });
    } catch (error) {
      this.scheduleInfrastructureRetry(this.threads.getRequired(thread.thread_id), errorMessage(error));
    }
  }

  private queueDirective(thread: CodexThreadRecord, decision: CodexReconcileDecision): void {
    const alternative = decision.action === "continue_alternative";
    const verifying = decision.action === "verify";
    const content = verifying
      ? "Perform an independent verification of the active goal and its acceptance criteria. Run the relevant checks, avoid unrelated changes, and report any failure before claiming success. Follow the codex-supervised-goal Skill."
      : alternative
        ? "The previous turn failed. Continue the active goal using a materially different bounded strategy. Inspect current state first and report a durable checkpoint. Follow the codex-supervised-goal Skill."
        : "Continue working autonomously toward the active goal. Inspect current state first, take the smallest useful implementation step, validate it, and report a durable checkpoint. Follow the codex-supervised-goal Skill.";
    this.directives.enqueue({
      thread_id: thread.thread_id,
      kind: verifying ? "verify" : "continue",
      content,
      actor_id: this.ownerId,
      channel: "supervisor",
      idempotency_key: `supervisor:${thread.thread_id}:${thread.revision}:${decision.action}`,
    });
    this.transition(this.threads.getRequired(thread.thread_id), {
      phase: decision.phase,
      strategy_attempts: alternative ? thread.strategy_attempts + 1 : thread.strategy_attempts,
      last_turn_status: null,
    });
  }

  private async pause(client: CodexAppServerClient, thread: CodexThreadRecord, reason: string): Promise<void> {
    try { await client.setGoal(thread.thread_id, { status: "paused" }); } catch { /* Local fail-closed pause still wins. */ }
    this.directives.cancelQueued(thread.thread_id);
    this.transition(this.threads.getRequired(thread.thread_id), { phase: "paused", goal_status: "paused", last_error: reason });
    this.releaseThread(thread.thread_id);
  }

  private scheduleInfrastructureRetry(thread: CodexThreadRecord, reason: string): void {
    const retries = thread.infra_retries + 1;
    if (retries > INFRASTRUCTURE_BACKOFF_MS.length) {
      this.transition(this.threads.getRequired(thread.thread_id), {
        phase: "failed", infra_retries: retries, completed_at: this.now().toISOString(), last_error: reason,
      });
      this.releaseThread(thread.thread_id);
      return;
    }
    this.transition(this.threads.getRequired(thread.thread_id), {
      phase: "retry_wait",
      infra_retries: retries,
      next_action_at: new Date(this.now().getTime() + INFRASTRUCTURE_BACKOFF_MS[retries - 1]!).toISOString(),
      last_error: reason,
    });
  }

  private transition(thread: CodexThreadRecord, patch: ThreadControlPatch): void {
    this.threads.updateControl(thread.thread_id, thread.revision, patch);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
