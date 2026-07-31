import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { StateDatabase } from "./state-database";

export interface ActionRecord {
  id: string;
  idempotency_key: string;
  asset_id: string;
  member_id: string;
  action: string;
  request_hash: string;
  status: "executing" | "completed" | "failed";
  attempts: number;
  started_at: string;
  updated_at: string;
  evidence?: string;
  error?: string;
}

interface ActionRow extends Omit<ActionRecord, "evidence" | "error"> {
  evidence: string | null;
  error: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
}

export class ActionJournal {
  private readonly state: StateDatabase;

  constructor(private readonly dataDir: string) {
    this.state = StateDatabase.open(dataDir);
    this.importLegacy();
  }

  async executeOnce<T>(input: {
    idempotency_key: string;
    asset_id: string;
    member_id: string;
    action: string;
    request: unknown;
  }, operation: () => Promise<T>, evidence: (result: T) => string): Promise<{ result: T; record: ActionRecord; replayed: boolean }> {
    const requestHash = createHash("sha256").update(JSON.stringify(input.request)).digest("hex");
    const { record, leaseToken } = this.reserve(input, requestHash);
    try {
      const result = await operation();
      const completed = this.finalize(record.id, leaseToken, "completed", evidence(result).slice(0, 4_000));
      return { result, record: completed, replayed: false };
    } catch (error) {
      this.finalize(record.id, leaseToken, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async list(): Promise<ActionRecord[]> {
    return (this.state.db.query("SELECT * FROM action_journal ORDER BY started_at ASC").all() as ActionRow[])
      .map(fromRow);
  }

  private reserve(input: {
    idempotency_key: string;
    asset_id: string;
    member_id: string;
    action: string;
    request: unknown;
  }, requestHash: string): { record: ActionRecord; leaseToken: string } {
    return this.state.db.transaction(() => {
      const existing = this.state.db.query("SELECT * FROM action_journal WHERE idempotency_key=?")
        .get(input.idempotency_key) as ActionRow | null;
      const now = new Date();
      if (existing?.status === "completed") throw new Error(`Action already completed for idempotency key ${input.idempotency_key}`);
      if (existing?.status === "executing" && Date.parse(existing.lease_expires_at ?? existing.updated_at) > now.getTime()) {
        throw new Error(`Action is already executing for idempotency key ${input.idempotency_key}`);
      }
      if (existing && existing.request_hash !== requestHash) throw new Error("Idempotency key was reused with a different request");
      const leaseToken = crypto.randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
      const record: ActionRecord = existing ? {
        ...fromRow(existing), status: "executing", attempts: existing.attempts + 1,
        updated_at: now.toISOString(), error: undefined,
      } : {
        id: crypto.randomUUID(), idempotency_key: input.idempotency_key,
        asset_id: input.asset_id, member_id: input.member_id, action: input.action,
        request_hash: requestHash, status: "executing", attempts: 1,
        started_at: now.toISOString(), updated_at: now.toISOString(),
      };
      this.state.db.query(`
        INSERT INTO action_journal(
          id,idempotency_key,asset_id,member_id,action,request_hash,status,attempts,
          lease_token,lease_expires_at,started_at,updated_at,evidence,error
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,attempts=excluded.attempts,lease_token=excluded.lease_token,
          lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at,error=NULL
      `).run(
        record.id, record.idempotency_key, record.asset_id, record.member_id, record.action,
        record.request_hash, record.status, record.attempts, leaseToken, leaseExpiresAt,
        record.started_at, record.updated_at, record.evidence ?? null, null,
      );
      return { record, leaseToken };
    })();
  }

  private finalize(id: string, leaseToken: string, status: "completed" | "failed", value: string): ActionRecord {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE action_journal
      SET status=?, evidence=?, error=?, lease_token=NULL, lease_expires_at=NULL, updated_at=?
      WHERE id=? AND lease_token=? AND status='executing'
    `).run(status, status === "completed" ? value : null, status === "failed" ? value.slice(0, 4_000) : null, now, id, leaseToken);
    if (result.changes !== 1) throw new Error(`Action lease was lost before completion: ${id}`);
    return fromRow(this.state.db.query("SELECT * FROM action_journal WHERE id=?").get(id) as ActionRow);
  }

  private importLegacy(): void {
    this.state.importJsonFile<ActionRecord>(
      resolve(this.dataDir, "action-journal.json"),
      (value) => {
        if (!Array.isArray(value)) throw new Error("expected action array");
        return value as ActionRecord[];
      },
      (record) => {
        this.state.db.query(`
          INSERT OR IGNORE INTO action_journal(
            id,idempotency_key,asset_id,member_id,action,request_hash,status,attempts,
            started_at,updated_at,evidence,error
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          record.id, record.idempotency_key, record.asset_id, record.member_id, record.action,
          record.request_hash, record.status, record.attempts, record.started_at, record.updated_at,
          record.evidence ?? null, record.error ?? null,
        );
      },
    );
  }
}

function fromRow(row: ActionRow): ActionRecord {
  return {
    id: row.id, idempotency_key: row.idempotency_key, asset_id: row.asset_id,
    member_id: row.member_id, action: row.action, request_hash: row.request_hash,
    status: row.status, attempts: row.attempts, started_at: row.started_at,
    updated_at: row.updated_at, evidence: row.evidence ?? undefined, error: row.error ?? undefined,
  };
}
