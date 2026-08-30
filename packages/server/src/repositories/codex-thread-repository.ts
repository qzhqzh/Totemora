import type { CodexThread } from "../integrations/codex-app-server-client";
import { StateDatabase } from "../state-database";
import type {
  CodexSupervisionMode,
  CodexSupervisorPhase,
  CodexThreadRecord,
} from "../domains/codex/codex-supervisor-types";

interface ThreadRow extends Omit<
  CodexThreadRecord,
  "workplace_id" | "title" | "source" | "history_mode" | "goal_objective" | "goal_status" | "token_budget"
  | "deadline_at" | "turn_timeout_at" | "current_turn_id" | "last_turn_status" | "next_action_at"
  | "last_directive_at" | "managed_at" | "completed_at" | "last_error"
> {
  workplace_id: string | null;
  title: string | null;
  source_json: string;
  history_mode: CodexThreadRecord["history_mode"] | null;
  goal_objective: string | null;
  goal_status: string | null;
  token_budget: number | null;
  deadline_at: string | null;
  turn_timeout_at: string | null;
  current_turn_id: string | null;
  last_turn_status: string | null;
  next_action_at: string | null;
  last_directive_at: string | null;
  managed_at: string | null;
  completed_at: string | null;
  last_error: string | null;
}

export interface ThreadControlPatch {
  phase?: CodexSupervisorPhase;
  goal_status?: string | null;
  token_used?: number;
  turn_timeout_at?: string | null;
  current_turn_id?: string | null;
  last_turn_status?: string | null;
  infra_retries?: number;
  strategy_attempts?: number;
  next_action_at?: string | null;
  last_directive_at?: string | null;
  completed_at?: string | null;
  last_error?: string | null;
}

export class CodexThreadRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  observe(threads: Array<{ thread: CodexThread; workplace_id?: string }>, observedAt = new Date().toISOString()): void {
    this.state.db.transaction(() => {
      for (const { thread, workplace_id } of threads) {
        const appStatus = thread.status.type;
        const title = typeof thread.name === "string" && thread.name.trim() ? thread.name : null;
        const preview = typeof thread.preview === "string" ? thread.preview.slice(0, 4_000) : "";
        const sourceJson = JSON.stringify(thread.source ?? null);
        this.state.db.query(`
          INSERT INTO codex_threads(
            thread_id,cwd,workplace_id,title,preview,source_json,app_status,app_updated_at,
            history_mode,last_observed_at,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id) DO UPDATE SET
            cwd=excluded.cwd,workplace_id=excluded.workplace_id,title=excluded.title,
            preview=excluded.preview,source_json=excluded.source_json,app_status=excluded.app_status,
            app_updated_at=excluded.app_updated_at,
            history_mode=COALESCE(excluded.history_mode,codex_threads.history_mode),
            last_observed_at=excluded.last_observed_at,
            revision=codex_threads.revision + CASE WHEN
              codex_threads.cwd IS NOT excluded.cwd
              OR codex_threads.workplace_id IS NOT excluded.workplace_id
              OR codex_threads.title IS NOT excluded.title
              OR codex_threads.preview IS NOT excluded.preview
              OR codex_threads.source_json IS NOT excluded.source_json
              OR codex_threads.app_status IS NOT excluded.app_status
              OR codex_threads.app_updated_at IS NOT excluded.app_updated_at
              OR (excluded.history_mode IS NOT NULL AND codex_threads.history_mode IS NOT excluded.history_mode)
            THEN 1 ELSE 0 END,
            updated_at=CASE WHEN
              codex_threads.cwd IS NOT excluded.cwd
              OR codex_threads.workplace_id IS NOT excluded.workplace_id
              OR codex_threads.title IS NOT excluded.title
              OR codex_threads.preview IS NOT excluded.preview
              OR codex_threads.source_json IS NOT excluded.source_json
              OR codex_threads.app_status IS NOT excluded.app_status
              OR codex_threads.app_updated_at IS NOT excluded.app_updated_at
              OR (excluded.history_mode IS NOT NULL AND codex_threads.history_mode IS NOT excluded.history_mode)
            THEN excluded.updated_at ELSE codex_threads.updated_at END
        `).run(
          thread.id, thread.cwd, workplace_id ?? null, title, preview, sourceJson, appStatus,
          Number.isFinite(thread.updatedAt) ? thread.updatedAt : 0, thread.historyMode ?? null,
          observedAt, observedAt, observedAt,
        );
      }
    })();
  }

  manage(input: {
    thread_id: string;
    expected_revision: number;
    workplace_id: string;
    objective: string;
    token_budget: number;
    deadline_at: string;
    now?: string;
  }): CodexThreadRecord {
    const now = input.now ?? new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_threads SET
        workplace_id=?,mode='managed',phase='aligning',goal_objective=?,goal_status=NULL,
        token_budget=?,token_used=0,deadline_at=?,managed_at=?,completed_at=NULL,last_error=NULL,
        infra_retries=0,strategy_attempts=0,next_action_at=?,revision=revision+1,updated_at=?
      WHERE thread_id=? AND revision=?
    `).run(
      input.workplace_id, input.objective, input.token_budget, input.deadline_at, now, now, now,
      input.thread_id, input.expected_revision,
    );
    if (result.changes !== 1) throw new Error(`Codex thread revision conflict: ${input.thread_id}`);
    return this.getRequired(input.thread_id);
  }

  unmanage(threadId: string, expectedRevision: number): CodexThreadRecord {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_threads SET
        mode='observed',phase='observed',current_turn_id=NULL,turn_timeout_at=NULL,
        next_action_at=NULL,last_error=NULL,revision=revision+1,updated_at=?
      WHERE thread_id=? AND revision=?
    `).run(now, threadId, expectedRevision);
    if (result.changes !== 1) throw new Error(`Codex thread revision conflict: ${threadId}`);
    return this.getRequired(threadId);
  }

  updateControl(threadId: string, expectedRevision: number, patch: ThreadControlPatch): CodexThreadRecord {
    const current = this.getRequired(threadId);
    const next = { ...current, ...normalizePatch(patch) };
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_threads SET
        phase=?,goal_status=?,token_used=?,turn_timeout_at=?,current_turn_id=?,last_turn_status=?,
        infra_retries=?,strategy_attempts=?,next_action_at=?,last_directive_at=?,completed_at=?,
        last_error=?,revision=revision+1,updated_at=?
      WHERE thread_id=? AND revision=?
    `).run(
      next.phase, next.goal_status ?? null, next.token_used, next.turn_timeout_at ?? null,
      next.current_turn_id ?? null, next.last_turn_status ?? null, next.infra_retries,
      next.strategy_attempts, next.next_action_at ?? null, next.last_directive_at ?? null,
      next.completed_at ?? null, next.last_error ?? null, now, threadId, expectedRevision,
    );
    if (result.changes !== 1) throw new Error(`Codex thread revision conflict: ${threadId}`);
    return this.getRequired(threadId);
  }

  get(threadId: string): CodexThreadRecord | undefined {
    const row = this.state.db.query("SELECT * FROM codex_threads WHERE thread_id=?").get(threadId) as ThreadRow | null;
    return row ? fromRow(row) : undefined;
  }

  getRequired(threadId: string): CodexThreadRecord {
    const thread = this.get(threadId);
    if (!thread) throw new Error(`Codex thread not found: ${threadId}`);
    return thread;
  }

  updateAppStatus(threadId: string, status: string, appUpdatedAt = Date.now()): CodexThreadRecord | undefined {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_threads SET app_status=?,app_updated_at=?,revision=revision+1,updated_at=?,last_observed_at=?
      WHERE thread_id=? AND (app_status IS NOT ? OR app_updated_at IS NOT ?)
    `).run(status, appUpdatedAt, now, now, threadId, status, appUpdatedAt);
    return result.changes ? this.getRequired(threadId) : this.get(threadId);
  }

  list(input: { mode?: CodexSupervisionMode; phase?: CodexSupervisorPhase; limit?: number; offset?: number } = {}): CodexThreadRecord[] {
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.mode) { filters.push("mode=?"); parameters.push(input.mode); }
    if (input.phase) { filters.push("phase=?"); parameters.push(input.phase); }
    const limit = Math.max(1, Math.min(500, input.limit ?? 100));
    const offset = Math.max(0, input.offset ?? 0);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (this.state.db.query(`
      SELECT * FROM codex_threads ${where} ORDER BY app_updated_at DESC,thread_id LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset) as ThreadRow[]).map(fromRow);
  }

  counts(): { observed: number; running: number; managed: number; active_managed: number } {
    const row = this.state.db.query(`
      SELECT COUNT(*) AS observed,
        SUM(CASE WHEN app_status='active' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN mode='managed' THEN 1 ELSE 0 END) AS managed,
        SUM(CASE WHEN mode='managed' AND phase IN ('aligning','executing','retry_wait','verifying') THEN 1 ELSE 0 END) AS active_managed
      FROM codex_threads
    `).get() as { observed: number; running: number | null; managed: number | null; active_managed: number | null };
    return {
      observed: row.observed,
      running: row.running ?? 0,
      managed: row.managed ?? 0,
      active_managed: row.active_managed ?? 0,
    };
  }

  phaseCounts(): Partial<Record<CodexSupervisorPhase, number>> {
    const rows = this.state.db.query("SELECT phase,COUNT(*) AS count FROM codex_threads GROUP BY phase")
      .all() as Array<{ phase: CodexSupervisorPhase; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.phase, row.count]));
  }
}

function normalizePatch(patch: ThreadControlPatch): ThreadControlPatch {
  const result: ThreadControlPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return result;
}

function fromRow(row: ThreadRow): CodexThreadRecord {
  return {
    ...row,
    workplace_id: row.workplace_id ?? undefined,
    title: row.title ?? undefined,
    source: JSON.parse(row.source_json),
    history_mode: row.history_mode ?? undefined,
    goal_objective: row.goal_objective ?? undefined,
    goal_status: row.goal_status ?? undefined,
    token_budget: row.token_budget ?? undefined,
    deadline_at: row.deadline_at ?? undefined,
    turn_timeout_at: row.turn_timeout_at ?? undefined,
    current_turn_id: row.current_turn_id ?? undefined,
    last_turn_status: row.last_turn_status ?? undefined,
    next_action_at: row.next_action_at ?? undefined,
    last_directive_at: row.last_directive_at ?? undefined,
    managed_at: row.managed_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
    last_error: row.last_error ?? undefined,
    source_json: undefined,
  } as CodexThreadRecord;
}
