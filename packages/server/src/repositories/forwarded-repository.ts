import {
  FORWARDED_STATUS_VALUES,
  forwardedEventId,
  normalizeForwardedEvent,
  type ForwardedEvent,
  type ForwardedEventInput,
  type ForwardedSourceState,
  type ForwardedStatus,
} from "../domains/forwarded/forwarded-event";
import { StateDatabase } from "../state-database";

interface EventRow {
  id: string; source_id: string; source_message_id: string; content_hash: string; occurred_at: string;
  title: string; body: string; priority: number; tags_json: string; click_url: string | null;
  image_url: string | null; status: ForwardedStatus; attempts: number; result_json: string | null;
  last_error: string | null; legacy_ref: string | null; created_at: string; updated_at: string;
}
interface StateRow {
  source_id: string; cursor_time: number; last_success_at: string | null; last_error: string | null;
  last_added: number; updated_at: string;
}
export interface LegacyForwardedImportBundle {
  source_ref: string;
  source_sha256: string;
  source_row_count: number;
  cursor_time: number;
  events: Array<ForwardedEventInput & { legacy_ref: string; result?: unknown }>;
}
export interface ForwardedSummary {
  counts: Record<ForwardedStatus, number>;
  source?: ForwardedSourceState;
}

const IMPORT_NAMESPACE = "legacy:notice-ntfy:forwarded";
const TERMINAL = new Set<ForwardedStatus>(["completed", "uncertain", "deduped"]);

export class ForwardedRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) { this.state = StateDatabase.open(dataDir); }

  list(status: ForwardedStatus | "all" = "all", limit = 50): ForwardedEvent[] {
    boundedInteger(limit, "Forwarded list limit", 1, 100);
    const rows = status === "all"
      ? this.state.db.query("SELECT * FROM forwarded_events ORDER BY occurred_at DESC,id LIMIT ?").all(limit)
      : this.state.db.query("SELECT * FROM forwarded_events WHERE status=? ORDER BY occurred_at DESC,id LIMIT ?")
        .all(status, limit);
    return (rows as EventRow[]).map(eventFromRow);
  }

  pending(limit = 20): ForwardedEvent[] {
    boundedInteger(limit, "Forwarded pending limit", 1, 100);
    return (this.state.db.query(`
      SELECT * FROM forwarded_events WHERE status IN ('pending','failed')
      ORDER BY occurred_at,id LIMIT ?
    `).all(limit) as EventRow[]).map(eventFromRow);
  }

  sourceState(sourceId: string): ForwardedSourceState | undefined {
    const row = this.state.db.query("SELECT * FROM forwarded_source_state WHERE source_id=?")
      .get(stableKey(sourceId, "Forwarded source id", 64)) as StateRow | null;
    return row ? stateFromRow(row) : undefined;
  }

  ingestPoll(input: {
    source_id: string;
    events: ForwardedEventInput[];
    cursor_time: number;
    finished_at?: string;
  }): { inserted: number; pending: number; deduped: number; cursor_time: number } {
    const sourceId = stableKey(input.source_id, "Forwarded source id", 64);
    const finished = validIso(input.finished_at ?? new Date().toISOString(), "Forwarded poll finished_at");
    let inserted = 0;
    let pending = 0;
    let deduped = 0;
    let cursor = boundedInteger(input.cursor_time, "Forwarded cursor", 0, Number.MAX_SAFE_INTEGER);
    this.state.db.transaction(() => {
      for (const raw of input.events) {
        const event = normalizeForwardedEvent({ ...raw, source_id: sourceId });
        cursor = Math.max(cursor, Math.floor(Date.parse(event.occurred_at) / 1_000));
        const duplicate = this.isLegacyDuplicate(event.content_hash, event.occurred_at);
        const status: ForwardedStatus = duplicate ? "deduped" : "pending";
        const result = this.state.db.query(`
          INSERT OR IGNORE INTO forwarded_events(
            id,source_id,source_message_id,content_hash,occurred_at,title,body,priority,tags_json,
            click_url,image_url,status,attempts,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
        `).run(
          forwardedEventId(sourceId, event.source_message_id), sourceId, event.source_message_id,
          event.content_hash, event.occurred_at, event.title, event.body, event.priority,
          JSON.stringify(event.tags), event.click_url ?? null, event.image_url ?? null,
          status, finished, finished,
        );
        if (!result.changes) continue;
        inserted += 1;
        if (duplicate) deduped += 1;
        else pending += 1;
      }
      this.state.db.query(`
        INSERT INTO forwarded_source_state(
          source_id,cursor_time,last_success_at,last_error,last_added,updated_at
        ) VALUES(?,?,?,NULL,?,?)
        ON CONFLICT(source_id) DO UPDATE SET
          cursor_time=MAX(forwarded_source_state.cursor_time,excluded.cursor_time),
          last_success_at=excluded.last_success_at,last_error=NULL,
          last_added=excluded.last_added,updated_at=excluded.updated_at
      `).run(sourceId, cursor, finished, inserted, finished);
    })();
    return { inserted, pending, deduped, cursor_time: cursor };
  }

  recordPollFailure(sourceId: string, error: string, now = new Date().toISOString()): ForwardedSourceState {
    const id = stableKey(sourceId, "Forwarded source id", 64);
    const timestamp = validIso(now, "Forwarded poll failure timestamp");
    this.state.db.query(`
      INSERT INTO forwarded_source_state(source_id,cursor_time,last_error,last_added,updated_at)
      VALUES(?,0,?,0,?)
      ON CONFLICT(source_id) DO UPDATE SET last_error=excluded.last_error,last_added=0,updated_at=excluded.updated_at
    `).run(id, safeError(error), timestamp);
    return this.sourceState(id)!;
  }

  recordDelivery(input: {
    id: string;
    status: "completed" | "failed" | "uncertain";
    result?: unknown;
    error?: string;
    now?: string;
  }): ForwardedEvent {
    const existing = this.getRequired(input.id);
    if (TERMINAL.has(existing.status)) return existing;
    const now = validIso(input.now ?? new Date().toISOString(), "Forwarded delivery timestamp");
    this.state.db.query(`
      UPDATE forwarded_events SET status=?,attempts=attempts+1,result_json=?,last_error=?,updated_at=? WHERE id=?
    `).run(
      input.status, input.result === undefined ? null : boundedJson(input.result),
      input.error ? safeError(input.error) : null, now, input.id,
    );
    return this.getRequired(input.id);
  }

  summary(sourceId: string): ForwardedSummary {
    const counts = Object.fromEntries(FORWARDED_STATUS_VALUES.map((status) => [status, 0])) as Record<ForwardedStatus, number>;
    const rows = this.state.db.query("SELECT status,COUNT(*) AS count FROM forwarded_events GROUP BY status").all() as Array<{
      status: ForwardedStatus; count: number;
    }>;
    for (const row of rows) counts[row.status] = row.count;
    const source = this.sourceState(sourceId);
    return { counts, ...(source ? { source } : {}) };
  }

  importLegacy(bundle: LegacyForwardedImportBundle): { applied: boolean; events: number; inserted_events: number } {
    validateImport(bundle);
    let result = { applied: false, events: bundle.events.length, inserted_events: 0 };
    this.state.db.transaction(() => {
      const prior = this.state.db.query("SELECT payload_json FROM records WHERE namespace=? AND id=?")
        .get(IMPORT_NAMESPACE, bundle.source_ref) as { payload_json: string } | null;
      if (prior) {
        if ((JSON.parse(prior.payload_json) as { source_sha256?: string }).source_sha256 !== bundle.source_sha256) {
          throw new Error(`Legacy forwarded source changed after import: ${bundle.source_ref}`);
        }
        return;
      }
      let inserted = 0;
      for (const legacy of bundle.events) {
        const event = normalizeForwardedEvent(legacy);
        inserted += this.state.db.query(`
          INSERT OR IGNORE INTO forwarded_events(
            id,source_id,source_message_id,content_hash,occurred_at,title,body,priority,tags_json,
            click_url,image_url,status,attempts,result_json,legacy_ref,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'completed',1,?,?,?,?)
        `).run(
          forwardedEventId(event.source_id, event.source_message_id), event.source_id,
          event.source_message_id, event.content_hash, event.occurred_at, event.title, event.body,
          event.priority, JSON.stringify(event.tags), event.click_url ?? null, event.image_url ?? null,
          legacy.result === undefined ? null : boundedJson(legacy.result),
          stableKey(legacy.legacy_ref, "Legacy forwarded ref", 240), event.occurred_at, event.occurred_at,
        ).changes;
      }
      const now = new Date().toISOString();
      this.state.db.query(`
        INSERT INTO forwarded_source_state(source_id,cursor_time,last_success_at,last_added,updated_at)
        VALUES('legacy-forwarded',?,?,0,?)
        ON CONFLICT(source_id) DO UPDATE SET cursor_time=MAX(cursor_time,excluded.cursor_time),updated_at=excluded.updated_at
      `).run(bundle.cursor_time, now, now);
      this.state.db.query("INSERT INTO records(namespace,id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(IMPORT_NAMESPACE, bundle.source_ref, JSON.stringify({
          schema_version: 1, source_sha256: bundle.source_sha256, source_row_count: bundle.source_row_count,
          events: bundle.events.length, inserted_events: inserted, cursor_time: bundle.cursor_time, imported_at: now,
        }), now, now);
      result = { applied: true, events: bundle.events.length, inserted_events: inserted };
    })();
    return result;
  }

  private isLegacyDuplicate(contentHash: string, occurredAt: string): boolean {
    const epoch = Math.floor(Date.parse(occurredAt) / 1_000);
    return Boolean(this.state.db.query(`
      SELECT 1 FROM forwarded_events WHERE legacy_ref IS NOT NULL AND content_hash=?
      AND ABS(CAST(strftime('%s',occurred_at) AS INTEGER)-?)<=300 LIMIT 1
    `).get(contentHash, epoch));
  }
  private getRequired(id: string): ForwardedEvent {
    const row = this.state.db.query("SELECT * FROM forwarded_events WHERE id=?").get(id) as EventRow | null;
    if (!row) throw new Error(`Forwarded event not found: ${id}`);
    return eventFromRow(row);
  }
}

function eventFromRow(row: EventRow): ForwardedEvent {
  return {
    id: row.id, source_id: row.source_id, source_message_id: row.source_message_id,
    content_hash: row.content_hash, occurred_at: row.occurred_at, title: row.title, body: row.body,
    priority: row.priority, tags: JSON.parse(row.tags_json) as string[], status: row.status,
    attempts: row.attempts, created_at: row.created_at, updated_at: row.updated_at,
    ...(row.click_url ? { click_url: row.click_url } : {}), ...(row.image_url ? { image_url: row.image_url } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}), ...(row.legacy_ref ? { legacy_ref: row.legacy_ref } : {}),
  };
}
function stateFromRow(row: StateRow): ForwardedSourceState {
  return {
    source_id: row.source_id, cursor_time: row.cursor_time, last_added: row.last_added, updated_at: row.updated_at,
    ...(row.last_success_at ? { last_success_at: row.last_success_at } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
  };
}
function validateImport(bundle: LegacyForwardedImportBundle): void {
  stableKey(bundle.source_ref, "Legacy forwarded source_ref", 200);
  if (!/^[a-f0-9]{64}$/.test(bundle.source_sha256)) throw new Error("Legacy forwarded SHA-256 is invalid");
  boundedInteger(bundle.source_row_count, "Legacy forwarded row count", 0, Number.MAX_SAFE_INTEGER);
  boundedInteger(bundle.cursor_time, "Legacy forwarded cursor", 0, Number.MAX_SAFE_INTEGER);
}
function validIso(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be ISO-8601`);
  return new Date(value).toISOString();
}
function stableKey(value: string, label: string, maximum: number): string {
  if (!value || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}
function boundedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 64 * 1_024) throw new Error("Forwarded result is too large");
  return encoded;
}
function safeError(value: string): string { return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500) || "Unknown relay error"; }
