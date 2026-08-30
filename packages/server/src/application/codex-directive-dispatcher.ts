import {
  CodexAppServerRpcError,
  type CodexAppServerClient,
  type JsonObject,
} from "../integrations/codex-app-server-client";
import {
  CODEX_SUPERVISOR_MAX_CONCURRENCY,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  type CodexDirective,
  type CodexThreadRecord,
} from "../domains/codex/codex-supervisor-types";
import { CodexAgentCapabilityRepository } from "../repositories/codex-agent-capability-repository";
import { CodexDirectiveRepository } from "../repositories/codex-directive-repository";
import { CodexLeaseRepository, type CodexLeasePair } from "../repositories/codex-lease-repository";
import { CodexThreadRepository } from "../repositories/codex-thread-repository";
import { SettlementStore } from "../settlement-store";

const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_BACKOFF_MS = [15_000, 60_000] as const;

export class CodexDirectiveDispatcher {
  private readonly threads: CodexThreadRepository;
  private readonly directives: CodexDirectiveRepository;
  private readonly leases: CodexLeaseRepository;
  private readonly settlement: SettlementStore;
  private readonly capabilities: CodexAgentCapabilityRepository;
  private readonly leasePairs = new Map<string, CodexLeasePair>();

  constructor(
    dataDir: string,
    private readonly ownerId: string,
    private readonly now: () => Date,
    private readonly agentMcpUrl?: string,
  ) {
    this.threads = new CodexThreadRepository(dataDir);
    this.directives = new CodexDirectiveRepository(dataDir);
    this.leases = new CodexLeaseRepository(dataDir);
    this.settlement = new SettlementStore(dataDir);
    this.capabilities = new CodexAgentCapabilityRepository(dataDir);
  }

  async dispatchQueued(client: CodexAppServerClient): Promise<void> {
    for (let index = 0; index < CODEX_SUPERVISOR_MAX_CONCURRENCY; index += 1) {
      const directive = this.directives.leaseNext(this.ownerId);
      if (!directive) return;
      await this.dispatch(client, directive);
    }
  }

  releaseThread(threadId: string): void {
    const pair = this.leasePairs.get(threadId);
    if (pair) {
      this.leasePairs.delete(threadId);
      try { this.leases.release(pair); } catch { /* A newer fence already owns the resource. */ }
    } else {
      this.leases.releaseThread(threadId, this.ownerId);
    }
  }

  async renewActiveLease(thread: CodexThreadRecord): Promise<void> {
    const settlement = await this.settlement.get();
    const workplace = settlement.workplaces.find((item) => item.id === thread.workplace_id);
    if (!workplace) return;
    try { this.ensureLease(thread, workplace.path); } catch { /* An existing fence remains authoritative. */ }
  }

  private async dispatch(client: CodexAppServerClient, directive: CodexDirective): Promise<void> {
    const thread = this.threads.getRequired(directive.thread_id);
    const settlement = await this.settlement.get();
    const workplace = settlement.workplaces.find((item) => item.id === thread.workplace_id);
    if (!workplace) {
      this.directives.fail(directive.id, directive.lease_token!, "Registered Workplace is no longer available");
      this.transition(thread, "Registered Workplace is no longer available");
      return;
    }
    try {
      this.ensureLease(thread, workplace.path);
    } catch (error) {
      this.directives.retry(
        directive.id, directive.lease_token!, new Date(this.now().getTime() + 5_000).toISOString(), message(error),
      );
      return;
    }
    const issued = directive.kind === "steer" || !this.agentMcpUrl
      ? undefined
      : this.capabilities.mint(thread.thread_id, `pending:${directive.id}`, DEFAULT_CODEX_TURN_TIMEOUT_MS);
    try {
      await client.resumeManagedThread(thread.thread_id, {
        cwd: thread.cwd,
        ...(issued ? { config: agentMcpConfig(this.agentMcpUrl!, issued.token) } : {}),
      });
    } catch (error) {
      if (issued) this.capabilities.revokeToken(issued.token);
      this.handleKnownFailure(directive, "Codex thread preparation", error);
      return;
    }
    try {
      const response = directive.kind === "steer" && directive.target_turn_id
        ? await client.steerTurn(thread.thread_id, directive.target_turn_id, directive.content, directive.id)
        : await client.startManagedTurn(thread.thread_id, directive.content, directive.id);
      const turnId = readTurnId(response);
      if (issued) this.capabilities.bindTurn(issued.token, turnId);
      this.directives.complete(directive.id, directive.lease_token!);
      const current = this.threads.getRequired(thread.thread_id);
      this.threads.updateControl(thread.thread_id, current.revision, {
        phase: directive.kind === "verify" ? "verifying" : "executing",
        current_turn_id: turnId,
        last_turn_status: "inProgress",
        turn_timeout_at: new Date(this.now().getTime() + DEFAULT_CODEX_TURN_TIMEOUT_MS).toISOString(),
        last_directive_at: this.now().toISOString(),
        next_action_at: new Date(this.now().getTime() + 5_000).toISOString(),
        last_error: null,
      });
    } catch (error) {
      if (error instanceof CodexAppServerRpcError) {
        if (issued) this.capabilities.revokeToken(issued.token);
        this.handleKnownFailure(directive, "Codex directive delivery", error);
      } else {
        this.directives.uncertain(directive.id, directive.lease_token!, message(error));
        this.transition(this.threads.getRequired(thread.thread_id), "Directive delivery is uncertain; operator review is required");
      }
    }
  }

  private handleKnownFailure(directive: CodexDirective, stage: string, error: unknown): void {
    const detail = message(error);
    if (directive.attempts < MAX_DELIVERY_ATTEMPTS) {
      const availableAt = new Date(
        this.now().getTime() + DELIVERY_BACKOFF_MS[directive.attempts - 1]!,
      ).toISOString();
      const reason = `${stage} failed before turn delivery: ${detail}`;
      this.directives.retry(directive.id, directive.lease_token!, availableAt, reason);
      const thread = this.threads.getRequired(directive.thread_id);
      this.threads.updateControl(thread.thread_id, thread.revision, {
        phase: "retry_wait",
        next_action_at: availableAt,
        last_error: reason,
      });
    } else {
      const reason = `${stage} failed after ${directive.attempts} attempts: ${detail}`;
      this.directives.fail(directive.id, directive.lease_token!, reason);
      this.transition(this.threads.getRequired(directive.thread_id), reason);
    }
    this.releaseThread(directive.thread_id);
  }

  private ensureLease(thread: CodexThreadRecord, worktree: string): CodexLeasePair {
    const existing = this.leasePairs.get(thread.thread_id);
    if (existing) {
      const renewed = this.leases.renew(existing);
      this.leasePairs.set(thread.thread_id, renewed);
      return renewed;
    }
    const pair = this.leases.acquirePair({
      thread_id: thread.thread_id,
      canonical_worktree: worktree,
      owner_id: this.ownerId,
      max_concurrency: CODEX_SUPERVISOR_MAX_CONCURRENCY,
    });
    this.leasePairs.set(thread.thread_id, pair);
    return pair;
  }

  private transition(thread: CodexThreadRecord, error: string): void {
    this.threads.updateControl(thread.thread_id, thread.revision, {
      phase: "paused", next_action_at: null, last_error: error,
    });
  }
}

function readTurnId(response: JsonObject): string {
  const turn = response.turn;
  if (!turn || typeof turn !== "object" || typeof (turn as JsonObject).id !== "string") {
    throw new Error("Codex App Server returned no turn id after directive delivery");
  }
  return (turn as JsonObject).id as string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentMcpConfig(url: string, token: string): JsonObject {
  return {
    mcp_servers: {
      totemora_supervisor: {
        url,
        enabled: true,
        http_headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}
