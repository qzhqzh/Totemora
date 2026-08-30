import { StateDatabase } from "../state-database";
import type { CodexLease } from "../domains/codex/codex-supervisor-types";

export interface CodexLeasePair {
  thread: CodexLease;
  worktree: CodexLease;
}

export class CodexLeaseRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  acquirePair(input: {
    thread_id: string;
    canonical_worktree: string;
    owner_id: string;
    ttl_ms?: number;
    max_concurrency?: number;
  }): CodexLeasePair {
    return this.state.db.transaction(() => {
      const now = new Date();
      const nowText = now.toISOString();
      const ttlMs = Math.max(5_000, Math.min(5 * 60_000, input.ttl_ms ?? 60_000));
      const maxConcurrency = Math.max(1, Math.min(16, input.max_concurrency ?? 2));
      const active = this.state.db.query(`
        SELECT COUNT(*) AS count FROM codex_leases
        WHERE resource_type='worktree' AND expires_at>? AND resource_key<>?
      `).get(nowText, input.canonical_worktree) as { count: number };
      const currentWorktree = this.get("worktree", input.canonical_worktree);
      if ((!currentWorktree || currentWorktree.expires_at <= nowText) && active.count >= maxConcurrency) {
        throw new Error("Codex supervisor global concurrency limit reached");
      }
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const thread = this.acquireOne("thread", input.thread_id, input.thread_id, input.owner_id, nowText, expiresAt);
      const worktree = this.acquireOne("worktree", input.canonical_worktree, input.thread_id, input.owner_id, nowText, expiresAt);
      return { thread, worktree };
    })();
  }

  renew(pair: CodexLeasePair, ttlMs = 60_000): CodexLeasePair {
    return this.state.db.transaction(() => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + Math.max(5_000, Math.min(5 * 60_000, ttlMs))).toISOString();
      const thread = this.renewOne(pair.thread, expiresAt, now.toISOString());
      const worktree = this.renewOne(pair.worktree, expiresAt, now.toISOString());
      return { thread, worktree };
    })();
  }

  release(pair: CodexLeasePair): void {
    this.state.db.transaction(() => {
      const now = new Date().toISOString();
      this.releaseOne(pair.thread, now);
      this.releaseOne(pair.worktree, now);
    })();
  }

  releaseThread(threadId: string, ownerId: string): number {
    const now = new Date().toISOString();
    return this.state.db.query(`
      UPDATE codex_leases SET expires_at=?,updated_at=?
      WHERE thread_id=? AND owner_id=? AND expires_at>?
    `).run(now, now, threadId, ownerId, now).changes;
  }

  listActive(now = new Date().toISOString()): CodexLease[] {
    return this.state.db.query(`
      SELECT * FROM codex_leases WHERE expires_at>? ORDER BY resource_type,resource_key
    `).all(now) as CodexLease[];
  }

  private get(resourceType: CodexLease["resource_type"], resourceKey: string): CodexLease | undefined {
    return this.state.db.query(`
      SELECT * FROM codex_leases WHERE resource_type=? AND resource_key=?
    `).get(resourceType, resourceKey) as CodexLease | undefined;
  }

  private acquireOne(
    resourceType: CodexLease["resource_type"],
    resourceKey: string,
    threadId: string,
    ownerId: string,
    now: string,
    expiresAt: string,
  ): CodexLease {
    const existing = this.get(resourceType, resourceKey);
    if (existing && existing.expires_at > now && (existing.owner_id !== ownerId || existing.thread_id !== threadId)) {
      throw new Error(`Codex ${resourceType} lease is held by another supervisor: ${resourceKey}`);
    }
    const fencingToken = (existing?.fencing_token ?? 0) + 1;
    this.state.db.query(`
      INSERT INTO codex_leases(
        resource_type,resource_key,thread_id,owner_id,fencing_token,expires_at,acquired_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(resource_type,resource_key) DO UPDATE SET
        thread_id=excluded.thread_id,owner_id=excluded.owner_id,fencing_token=excluded.fencing_token,
        expires_at=excluded.expires_at,acquired_at=excluded.acquired_at,updated_at=excluded.updated_at
    `).run(resourceType, resourceKey, threadId, ownerId, fencingToken, expiresAt, now, now);
    return this.get(resourceType, resourceKey)!;
  }

  private renewOne(lease: CodexLease, expiresAt: string, now: string): CodexLease {
    const result = this.state.db.query(`
      UPDATE codex_leases SET expires_at=?,updated_at=?
      WHERE resource_type=? AND resource_key=? AND thread_id=? AND owner_id=? AND fencing_token=? AND expires_at>?
    `).run(
      expiresAt, now, lease.resource_type, lease.resource_key, lease.thread_id,
      lease.owner_id, lease.fencing_token, now,
    );
    if (result.changes !== 1) throw new Error(`Codex lease fence was lost: ${lease.resource_type}:${lease.resource_key}`);
    return this.get(lease.resource_type, lease.resource_key)!;
  }

  private releaseOne(lease: CodexLease, now: string): void {
    const result = this.state.db.query(`
      UPDATE codex_leases SET expires_at=?,updated_at=?
      WHERE resource_type=? AND resource_key=? AND thread_id=? AND owner_id=? AND fencing_token=?
    `).run(now, now, lease.resource_type, lease.resource_key, lease.thread_id, lease.owner_id, lease.fencing_token);
    if (result.changes !== 1) throw new Error(`Codex lease fence was lost: ${lease.resource_type}:${lease.resource_key}`);
  }
}
