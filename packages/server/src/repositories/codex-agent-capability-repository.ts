import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { StateDatabase } from "../state-database";

export interface CodexAgentCapability {
  thread_id: string;
  turn_id: string;
  expires_at: string;
}

interface CapabilityRow extends CodexAgentCapability {
  token_hash: string;
  revoked_at: string | null;
  created_at: string;
}

export class CodexAgentCapabilityRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  mint(threadId: string, turnId: string, ttlMs = 2 * 60 * 60_000): { token: string; capability: CodexAgentCapability } {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(60_000, Math.min(3 * 60 * 60_000, ttlMs))).toISOString();
    this.state.db.query(`
      INSERT INTO codex_agent_capabilities(token_hash,thread_id,turn_id,expires_at,created_at)
      VALUES(?,?,?,?,?)
    `).run(tokenHash, threadId, turnId, expiresAt, now.toISOString());
    return { token, capability: { thread_id: threadId, turn_id: turnId, expires_at: expiresAt } };
  }

  verify(token: string): CodexAgentCapability | undefined {
    if (!token || token.length > 256) return undefined;
    const candidate = hashToken(token);
    const row = this.state.db.query(`
      SELECT * FROM codex_agent_capabilities
      WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?
    `).get(candidate, new Date().toISOString()) as CapabilityRow | null;
    if (!row || !safeHashEqual(candidate, row.token_hash)) return undefined;
    return { thread_id: row.thread_id, turn_id: row.turn_id, expires_at: row.expires_at };
  }

  bindTurn(token: string, turnId: string): CodexAgentCapability {
    const tokenHash = hashToken(token);
    const result = this.state.db.query(`
      UPDATE codex_agent_capabilities SET turn_id=?
      WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?
    `).run(turnId, tokenHash, new Date().toISOString());
    if (result.changes !== 1) throw new Error("Codex agent capability cannot be bound to the turn");
    return this.verify(token)!;
  }

  bindLatestPending(threadId: string, turnId: string): boolean {
    const row = this.state.db.query(`
      SELECT token_hash FROM codex_agent_capabilities
      WHERE thread_id=? AND turn_id LIKE 'pending:%' AND revoked_at IS NULL AND expires_at>?
      ORDER BY created_at DESC LIMIT 1
    `).get(threadId, new Date().toISOString()) as { token_hash: string } | null;
    if (!row) return false;
    return this.state.db.query(`
      UPDATE codex_agent_capabilities SET turn_id=? WHERE token_hash=? AND turn_id LIKE 'pending:%'
    `).run(turnId, row.token_hash).changes === 1;
  }

  revokeToken(token: string): boolean {
    return this.state.db.query(`
      UPDATE codex_agent_capabilities SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL
    `).run(new Date().toISOString(), hashToken(token)).changes === 1;
  }

  revokeTurn(threadId: string, turnId: string): number {
    const now = new Date().toISOString();
    return this.state.db.query(`
      UPDATE codex_agent_capabilities SET revoked_at=?
      WHERE thread_id=? AND turn_id=? AND revoked_at IS NULL
    `).run(now, threadId, turnId).changes;
  }

  pruneExpired(now = new Date().toISOString()): number {
    return this.state.db.query("DELETE FROM codex_agent_capabilities WHERE expires_at<=?").run(now).changes;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
