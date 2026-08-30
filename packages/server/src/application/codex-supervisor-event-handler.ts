import type { CodexServerNotification, JsonObject } from "../integrations/codex-app-server-client";
import { DEFAULT_CODEX_TURN_TIMEOUT_MS } from "../domains/codex/codex-supervisor-types";
import { CodexAgentCapabilityRepository } from "../repositories/codex-agent-capability-repository";
import { CodexThreadRepository, type ThreadControlPatch } from "../repositories/codex-thread-repository";
import { CodexSupervisorReconciler } from "./codex-supervisor-reconciler";

export class CodexSupervisorEventHandler {
  private readonly threads: CodexThreadRepository;
  private readonly capabilities: CodexAgentCapabilityRepository;

  constructor(
    dataDir: string,
    private readonly reconciler: CodexSupervisorReconciler,
    private readonly now: () => Date,
  ) {
    this.threads = new CodexThreadRepository(dataDir);
    this.capabilities = new CodexAgentCapabilityRepository(dataDir);
  }

  handle(notification: CodexServerNotification): void {
    const params = objectValue(notification.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId || this.threads.get(threadId)?.mode !== "managed") return;
    if (notification.method === "thread/status/changed") {
      const status = objectValue(params.status);
      if (typeof status.type === "string") this.threads.updateAppStatus(threadId, status.type);
      return;
    }
    if (notification.method === "turn/started") {
      const turn = objectValue(params.turn);
      if (typeof turn.id === "string") {
        this.capabilities.bindLatestPending(threadId, turn.id);
        this.patchThread(threadId, {
          current_turn_id: turn.id,
          last_turn_status: "inProgress",
          turn_timeout_at: new Date(this.now().getTime() + DEFAULT_CODEX_TURN_TIMEOUT_MS).toISOString(),
        });
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = objectValue(params.turn);
      this.patchThread(threadId, {
        current_turn_id: null,
        turn_timeout_at: null,
        last_turn_status: typeof turn.status === "string" ? turn.status : "failed",
      });
      if (typeof turn.id === "string") this.capabilities.revokeTurn(threadId, turn.id);
      this.reconciler.releaseThread(threadId);
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const total = objectValue(objectValue(params.tokenUsage).total);
      if (typeof total.totalTokens === "number") this.patchThread(threadId, { token_used: total.totalTokens });
      return;
    }
    if (notification.method === "thread/goal/updated") {
      const goal = objectValue(params.goal);
      this.patchThread(threadId, {
        goal_status: typeof goal.status === "string" ? goal.status : null,
        token_used: typeof goal.tokensUsed === "number" ? goal.tokensUsed : undefined,
      });
      return;
    }
    if (notification.method === "thread/goal/cleared") this.patchThread(threadId, { goal_status: null });
  }

  private patchThread(threadId: string, patch: ThreadControlPatch): void {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const thread = this.threads.get(threadId);
      if (!thread || thread.mode !== "managed") return;
      try {
        this.threads.updateControl(threadId, thread.revision, patch);
        return;
      } catch (error) {
        if (!String(error).includes("revision conflict") || attempt === 2) throw error;
      }
    }
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
