import { createHash, randomUUID } from "node:crypto";

import type { ExternalNotificationEvent } from "../domains/notification/external-event";
import { NotifierDatabase } from "../storage";

export class ExternalNotificationConflictError extends Error {}

export const EXTERNAL_EVENT_STATUSES = [
  "pending", "unrouted", "coalesced", "sending", "completed", "failed", "uncertain",
] as const;
export type ExternalEventStatus = typeof EXTERNAL_EVENT_STATUSES[number];

interface EventRow {
  event_uuid: string;
  source_id: string;
  external_id: string;
  type: string;
  payload_hash: string;
  title: string;
  body: string;
  priority: ExternalNotificationEvent["priority"];
  occurred_at: string;
  dedupe_key: string | null;
  coalesced_by: string | null;
  route_targets_json: string;
  status: ExternalEventStatus;
  attempts: number;
  result_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredExternalNotificationEvent {
  event_uuid: string;
  source: string;
  id: string;
  type: string;
  title: string;
  body: string;
  priority: ExternalNotificationEvent["priority"];
  occurred_at: string;
  dedupe_key?: string;
  coalesced_by?: string;
  route_targets: string[];
  status: ExternalEventStatus;
  attempts: number;
  result?: unknown;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export class ExternalNotificationRepository {
  private readonly db: NotifierDatabase["db"];

  constructor(dataDir: string) {
    this.db = NotifierDatabase.open(dataDir).db;
  }

  findDuplicate(event: ExternalNotificationEvent): StoredExternalNotificationEvent | undefined {
    const previous = this.db.query(`
      SELECT * FROM external_notification_events WHERE source_id=? AND external_id=?
    `).get(event.source, event.id) as EventRow | null;
    if (!previous) return undefined;
    if (previous.payload_hash !== payloadHash(event)) {
      throw new ExternalNotificationConflictError("source + id was already used for a different event");
    }
    return fromRow(previous);
  }

  accept(input: {
    event: ExternalNotificationEvent;
    targets: string[];
    coalesce_window_seconds: number;
    unrouted_reason?: string;
  }): { event: StoredExternalNotificationEvent; duplicate: boolean } {
    return this.db.transaction(() => {
      const { event } = input;
      const hash = payloadHash(event);
      const previous = this.db.query(`
        SELECT * FROM external_notification_events WHERE source_id=? AND external_id=?
      `).get(event.source, event.id) as EventRow | null;
      if (previous) {
        if (previous.payload_hash !== hash) throw new ExternalNotificationConflictError("source + id was already used for a different event");
        return { event: fromRow(previous), duplicate: true };
      }
      const now = new Date().toISOString();
      const since = new Date(Date.now() - input.coalesce_window_seconds * 1_000).toISOString();
      const origin = input.targets.length && event.dedupe_key && input.coalesce_window_seconds > 0
        ? this.db.query(`
          SELECT event_uuid FROM external_notification_events
          WHERE source_id=? AND type=? AND dedupe_key=? AND route_targets_json=? AND created_at>=?
            AND status IN ('pending','sending','completed')
          ORDER BY created_at DESC LIMIT 1
        `).get(event.source, event.type, event.dedupe_key, JSON.stringify(input.targets), since) as { event_uuid: string } | null
        : null;
      const status = !input.targets.length ? "unrouted" : origin ? "coalesced" : "pending";
      const id = randomUUID();
      this.db.query(`
        INSERT INTO external_notification_events(
          event_uuid,source_id,external_id,type,payload_hash,title,body,priority,occurred_at,
          dedupe_key,coalesced_by,route_targets_json,status,attempts,result_json,last_error,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,?)
      `).run(
        id, event.source, event.id, event.type, hash, event.title, event.body, event.priority,
        event.occurred_at ?? now, event.dedupe_key ?? null, origin?.event_uuid ?? null,
        JSON.stringify(input.targets), status, input.unrouted_reason ?? null, now, now,
      );
      const row = this.db.query("SELECT * FROM external_notification_events WHERE event_uuid=?").get(id) as EventRow;
      return { event: fromRow(row), duplicate: false };
    })();
  }

  list(status: ExternalEventStatus | "all", limit: number): StoredExternalNotificationEvent[] {
    const rows = status === "all"
      ? this.db.query("SELECT * FROM external_notification_events ORDER BY created_at DESC LIMIT ?").all(limit)
      : this.db.query("SELECT * FROM external_notification_events WHERE status=? ORDER BY created_at DESC LIMIT ?").all(status, limit);
    return (rows as EventRow[]).map(fromRow);
  }

  get(id: string): StoredExternalNotificationEvent | undefined {
    const row = this.db.query("SELECT * FROM external_notification_events WHERE event_uuid=?").get(id) as EventRow | null;
    return row ? fromRow(row) : undefined;
  }

  claim(limit: number): StoredExternalNotificationEvent[] {
    return this.db.transaction(() => {
      const pending = this.db.query(`
        SELECT event_uuid FROM external_notification_events WHERE status='pending'
        ORDER BY created_at,event_uuid LIMIT ?
      `).all(limit) as Array<{ event_uuid: string }>;
      const now = new Date().toISOString();
      for (const item of pending) {
        this.db.query(`
          UPDATE external_notification_events SET status='sending',attempts=attempts+1,updated_at=?
          WHERE event_uuid=? AND status='pending'
        `).run(now, item.event_uuid);
      }
      return pending.map((item) => fromRow(this.db.query(
        "SELECT * FROM external_notification_events WHERE event_uuid=?",
      ).get(item.event_uuid) as EventRow));
    })();
  }

  finish(id: string, status: "completed" | "failed" | "uncertain" | "unrouted", result?: unknown): void {
    const changed = this.db.query(`
      UPDATE external_notification_events SET status=?, result_json=?,last_error=?,updated_at=?
      WHERE event_uuid=? AND status='sending'
    `).run(status, result === undefined ? null : JSON.stringify(result),
      status === "completed" ? null : status === "unrouted" ? "Targets are no longer available"
        : status === "uncertain" ? "Delivery outcome requires operator reconciliation"
          : "Delivery failed; operator may retry", new Date().toISOString(), id);
    if (changed.changes !== 1) throw new Error("Notification delivery claim was lost");
  }

  recoverStaleSending(): number {
    const threshold = new Date(Date.now() - 5 * 60_000).toISOString();
    return this.db.query(`
      UPDATE external_notification_events
      SET status='uncertain',last_error='Delivery process stopped before result was recorded',updated_at=?
      WHERE status='sending' AND updated_at<?
    `).run(new Date().toISOString(), threshold).changes;
  }

  retryFailed(id: string): StoredExternalNotificationEvent {
    const changed = this.db.query(`
      UPDATE external_notification_events SET status='pending',last_error=NULL,updated_at=?
      WHERE event_uuid=? AND status='failed'
    `).run(new Date().toISOString(), id);
    if (changed.changes !== 1) throw new ExternalNotificationConflictError("Only definitively failed deliveries may be retried");
    return fromRow(this.db.query("SELECT * FROM external_notification_events WHERE event_uuid=?").get(id) as EventRow);
  }
}

function payloadHash(event: ExternalNotificationEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function fromRow(row: EventRow): StoredExternalNotificationEvent {
  return {
    event_uuid: row.event_uuid, source: row.source_id, id: row.external_id, type: row.type,
    title: row.title, body: row.body, priority: row.priority, occurred_at: row.occurred_at,
    ...(row.dedupe_key ? { dedupe_key: row.dedupe_key } : {}),
    ...(row.coalesced_by ? { coalesced_by: row.coalesced_by } : {}),
    route_targets: JSON.parse(row.route_targets_json) as string[], status: row.status,
    attempts: row.attempts, ...(row.result_json ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
