import { StateDatabase } from "../state-database";
import type {
  CodexDirective,
  CodexDirectiveKind,
} from "../domains/codex/codex-supervisor-types";

interface DirectiveRow extends Omit<
  CodexDirective,
  "target_turn_id" | "lease_token" | "lease_expires_at" | "completed_at" | "error"
> {
  target_turn_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
  error: string | null;
}

export class CodexDirectiveRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  enqueue(input: {
    thread_id: string;
    kind: CodexDirectiveKind;
    content: string;
    actor_id: string;
    channel: CodexDirective["channel"];
    idempotency_key: string;
    target_turn_id?: string;
    available_at?: string;
  }): CodexDirective {
    const existing = this.byIdempotencyKey(input.idempotency_key);
    if (existing) {
      if (existing.thread_id !== input.thread_id || existing.kind !== input.kind || existing.content !== input.content) {
        throw new Error("Codex directive idempotency key was reused with a different request");
      }
      return existing;
    }
    const content = input.content.trim();
    if (!content || content.length > 20_000) throw new Error("Codex directive content must contain 1-20000 characters");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.state.db.query(`
      INSERT INTO codex_directives(
        id,thread_id,kind,content,actor_id,channel,target_turn_id,status,idempotency_key,
        available_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?)
    `).run(
      id, input.thread_id, input.kind, content, input.actor_id, input.channel,
      input.target_turn_id ?? null, input.idempotency_key, input.available_at ?? now, now, now,
    );
    return this.getRequired(id);
  }

  leaseNext(ownerId: string, leaseMs = 60_000): CodexDirective | undefined {
    return this.state.db.transaction(() => {
      const now = new Date();
      const row = this.state.db.query(`
        SELECT d.* FROM codex_directives d
        JOIN codex_threads t ON t.thread_id=d.thread_id
        WHERE d.status='queued' AND d.available_at<=? AND t.mode='managed'
        ORDER BY d.available_at,d.created_at LIMIT 1
      `).get(now.toISOString()) as DirectiveRow | null;
      if (!row) return undefined;
      const leaseToken = `${ownerId}:${crypto.randomUUID()}`;
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const result = this.state.db.query(`
        UPDATE codex_directives SET
          status='leased',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=?
        WHERE id=? AND status='queued'
      `).run(leaseToken, expiresAt, now.toISOString(), row.id);
      if (result.changes !== 1) return undefined;
      return this.getRequired(row.id);
    })();
  }

  complete(id: string, leaseToken: string): CodexDirective {
    return this.finalize(id, leaseToken, "completed");
  }

  fail(id: string, leaseToken: string, error: string): CodexDirective {
    return this.finalize(id, leaseToken, "failed", error);
  }

  uncertain(id: string, leaseToken: string, error: string): CodexDirective {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_directives SET
        status='uncertain',completed_at=?,lease_token=NULL,lease_expires_at=NULL,error=?,updated_at=?
      WHERE id=? AND status='leased' AND lease_token=?
    `).run(now, error.slice(0, 4_000), now, id, leaseToken);
    if (result.changes !== 1) throw new Error(`Codex directive lease was lost: ${id}`);
    return this.getRequired(id);
  }

  retry(id: string, leaseToken: string, availableAt: string, error: string): CodexDirective {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_directives SET
        status='queued',available_at=?,lease_token=NULL,lease_expires_at=NULL,error=?,updated_at=?
      WHERE id=? AND status='leased' AND lease_token=?
    `).run(availableAt, error.slice(0, 4_000), now, id, leaseToken);
    if (result.changes !== 1) throw new Error(`Codex directive lease was lost: ${id}`);
    return this.getRequired(id);
  }

  markExpiredLeasesUncertain(now = new Date().toISOString()): number {
    return this.state.db.query(`
      UPDATE codex_directives SET
        status='uncertain',lease_token=NULL,lease_expires_at=NULL,
        error='Delivery acknowledgement was not durably recorded; automatic replay is blocked',updated_at=?
      WHERE status='leased' AND lease_expires_at<=?
    `).run(now, now).changes;
  }

  cancelQueued(threadId: string): number {
    const now = new Date().toISOString();
    return this.state.db.query(`
      UPDATE codex_directives SET status='cancelled',updated_at=?
      WHERE thread_id=? AND status='queued'
    `).run(now, threadId).changes;
  }

  get(id: string): CodexDirective | undefined {
    const row = this.state.db.query("SELECT * FROM codex_directives WHERE id=?").get(id) as DirectiveRow | null;
    return row ? fromRow(row) : undefined;
  }

  list(threadId: string, limit = 100): CodexDirective[] {
    return (this.state.db.query(`
      SELECT * FROM codex_directives WHERE thread_id=? ORDER BY created_at DESC LIMIT ?
    `).all(threadId, Math.max(1, Math.min(500, limit))) as DirectiveRow[]).map(fromRow);
  }

  hasPending(threadId: string): boolean {
    return Boolean(this.state.db.query(`
      SELECT 1 FROM codex_directives WHERE thread_id=? AND status IN ('queued','leased') LIMIT 1
    `).get(threadId));
  }

  counts(): Partial<Record<CodexDirective["status"], number>> {
    const rows = this.state.db.query("SELECT status,COUNT(*) AS count FROM codex_directives GROUP BY status")
      .all() as Array<{ status: CodexDirective["status"]; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  private byIdempotencyKey(key: string): CodexDirective | undefined {
    const row = this.state.db.query("SELECT * FROM codex_directives WHERE idempotency_key=?").get(key) as DirectiveRow | null;
    return row ? fromRow(row) : undefined;
  }

  private getRequired(id: string): CodexDirective {
    const directive = this.get(id);
    if (!directive) throw new Error(`Codex directive not found: ${id}`);
    return directive;
  }

  private finalize(id: string, leaseToken: string, status: "completed" | "failed", error?: string): CodexDirective {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_directives SET
        status=?,completed_at=?,lease_token=NULL,lease_expires_at=NULL,error=?,updated_at=?
      WHERE id=? AND status='leased' AND lease_token=?
    `).run(status, now, error?.slice(0, 4_000) ?? null, now, id, leaseToken);
    if (result.changes !== 1) throw new Error(`Codex directive lease was lost: ${id}`);
    return this.getRequired(id);
  }
}

function fromRow(row: DirectiveRow): CodexDirective {
  return {
    ...row,
    target_turn_id: row.target_turn_id ?? undefined,
    lease_token: row.lease_token ?? undefined,
    lease_expires_at: row.lease_expires_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };
}
