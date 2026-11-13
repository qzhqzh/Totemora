import { createHash, randomUUID } from "node:crypto";

import { NotifierDatabase } from "./storage";

interface ActionRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  status: "executing" | "completed" | "failed" | "uncertain";
  evidence: string | null;
  error: string | null;
  lease_expires_at: string | null;
}

export class UncertainExternalEffectError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`External effect outcome is uncertain for idempotency key ${idempotencyKey}; automatic replay is blocked`);
  }
}

export class ActionJournal {
  private readonly db: NotifierDatabase["db"];

  constructor(dataDir: string) { this.db = NotifierDatabase.open(dataDir).db; }

  /** Bounded, operator-only metadata; never expose the stored request or raw transport receipt. */
  recent(limit: number, key?: string) {
    const rows = (key
      ? this.db.query(`SELECT idempotency_key,status,attempts,updated_at,error FROM action_journal
          WHERE substr(idempotency_key,1,length(?))=?
          ORDER BY updated_at DESC LIMIT ?`).all(`notification:${key}:`, `notification:${key}:`, limit)
      : this.db.query(`SELECT idempotency_key,status,attempts,updated_at,error FROM action_journal
          WHERE idempotency_key LIKE 'notification:%' ORDER BY updated_at DESC LIMIT ?`).all(limit)) as Array<{
        idempotency_key: string; status: string; attempts: number; updated_at: string; error: string | null;
      }>;
    return rows.map((row) => {
      const match = row.idempotency_key.match(/^notification:(.*):(bark|telegram|ntfy|email):([A-Za-z0-9._-]+)$/);
      return { idempotency_key: match?.[1] ?? row.idempotency_key, channel: match?.[2] ?? "unknown",
        target_id: match?.[3] ?? "unknown", status: row.status, attempts: row.attempts,
        updated_at: row.updated_at,
        ...(row.error ? { error: row.error.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 300) } : {}),
      };
    });
  }

  async executeEffectOnce(input: {
    idempotency_key: string; asset_id: string; member_id: string; action: string; request: unknown;
  }, operation: () => Promise<string>): Promise<{ record: { evidence?: string }; replayed: boolean }> {
    const hash = createHash("sha256").update(JSON.stringify(input.request)).digest("hex");
    const reservation = this.db.transaction(() => {
      const previous = this.db.query("SELECT * FROM action_journal WHERE idempotency_key=?")
        .get(input.idempotency_key) as ActionRow | null;
      if (previous && previous.request_hash !== hash) {
        throw new Error("Idempotency key was reused with a different request");
      }
      if (previous?.status === "completed") return { replayed: true as const, evidence: previous.evidence ?? undefined };
      if (previous?.status === "uncertain") throw new UncertainExternalEffectError(input.idempotency_key);
      if (previous?.status === "executing") {
        if (Date.parse(previous.lease_expires_at ?? "") > Date.now()) {
          // Another request owns an active lease; do not invalidate its eventual receipt.
          throw new UncertainExternalEffectError(input.idempotency_key);
        }
        // A previous process may have already sent the message. Never restart it.
        this.db.query("UPDATE action_journal SET status='uncertain', error=?, updated_at=? WHERE id=?")
          .run("Delivery stopped before the receipt was persisted", new Date().toISOString(), previous.id);
        return { uncertain: true as const };
      }
      const id = previous?.id ?? randomUUID();
      const lease = randomUUID();
      const now = new Date().toISOString();
      this.db.query(`
        INSERT INTO action_journal(id,idempotency_key,asset_id,member_id,action,request_hash,
          status,attempts,lease_token,lease_expires_at,started_at,updated_at)
        VALUES(?,?,?,?,?,?,'executing',1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status='executing',attempts=attempts+1,
          lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,
          updated_at=excluded.updated_at,error=NULL
      `).run(id, input.idempotency_key, input.asset_id, input.member_id, input.action, hash,
        lease, new Date(Date.now() + 300_000).toISOString(), now, now);
      return { replayed: false as const, id, lease };
    })();
    if ("uncertain" in reservation) throw new UncertainExternalEffectError(input.idempotency_key);
    if (reservation.replayed) return { record: { evidence: reservation.evidence }, replayed: true };

    let evidence: string;
    try {
      evidence = await operation();
    } catch (error) {
      const uncertain = typeof error === "object" && error !== null
        && "outcomeUncertain" in error && error.outcomeUncertain === true;
      try {
        this.finish(reservation.id, reservation.lease, uncertain ? "uncertain" : "failed",
          (error instanceof Error ? error.message : String(error)).slice(0, 4_000));
      } catch { throw new UncertainExternalEffectError(input.idempotency_key); }
      if (uncertain) throw new UncertainExternalEffectError(input.idempotency_key);
      throw error;
    }
    try {
      this.finish(reservation.id, reservation.lease, "completed", evidence.slice(0, 4_000));
      return { record: { evidence: evidence.slice(0, 4_000) }, replayed: false };
    } catch {
      // The channel might have accepted the message, even when the receipt cannot be committed.
      try { this.finish(reservation.id, reservation.lease, "uncertain", "Receipt persistence failed"); } catch {}
      throw new UncertainExternalEffectError(input.idempotency_key);
    }
  }

  private finish(id: string, lease: string, status: "completed" | "failed" | "uncertain", value: string): void {
    const result = this.db.query(`
      UPDATE action_journal SET status=?, evidence=?, error=?, lease_token=NULL,
        lease_expires_at=NULL, updated_at=? WHERE id=? AND lease_token=? AND status='executing'
    `).run(status, status === "completed" ? value : null, status === "completed" ? null : value,
      new Date().toISOString(), id, lease);
    if (result.changes !== 1) throw new Error("Notification delivery claim was lost");
  }
}
