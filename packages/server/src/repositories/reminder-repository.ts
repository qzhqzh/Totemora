import {
  assertLocalDate,
  assertReminderImportance,
  assertReminderTitle,
  type ReminderDeliveryKind,
  type ReminderDeliveryStatus,
  type ReminderDeliveryWindow,
  type ReminderImportance,
  type ReminderItem,
  type ReminderStatus,
} from "../domains/reminder/reminder";
import { StateDatabase } from "../state-database";

interface ReminderItemRow {
  id: string;
  title: string;
  deadline_local_date: string;
  importance: number;
  status: ReminderStatus;
  legacy_ref: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  expired_at: string | null;
}
interface ReminderDeliveryRow {
  delivery_key: string;
  reminder_id: string | null;
  kind: ReminderDeliveryKind;
  local_date: string;
  slot: number;
  status: ReminderDeliveryStatus;
  attempts: number;
  result_json: string | null;
  last_error: string | null;
  legacy_ref: string | null;
  created_at: string;
  updated_at: string;
}
export interface LegacyReminderImportBundle {
  source_ref: string;
  source_sha256: string;
  source_row_count: number;
  items: Array<ReminderItem & { legacy_ref: string }>;
  deliveries: Array<ReminderDeliveryWindow & { legacy_ref: string }>;
}
export interface LegacyReminderImportResult {
  applied: boolean;
  items: number;
  delivery_windows: number;
}
const IMPORT_NAMESPACE = "legacy:notice-ntfy:memo";
const TERMINAL_DELIVERY = new Set<ReminderDeliveryStatus>(["completed", "uncertain", "skipped_empty"]);

export class ReminderRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }
  create(input: {
    title: unknown;
    deadline_local_date: unknown;
    importance: unknown;
    now?: string;
  }): ReminderItem {
    const now = validIso(input.now ?? new Date().toISOString(), "Reminder created_at");
    const id = crypto.randomUUID();
    this.state.db.query(`
      INSERT INTO reminder_items(
        id,title,deadline_local_date,importance,status,created_at,updated_at
      ) VALUES(?,?,?,?,'active',?,?)
    `).run(
      id,
      assertReminderTitle(input.title),
      assertLocalDate(input.deadline_local_date),
      assertReminderImportance(input.importance),
      now,
      now,
    );
    return this.getRequired(id);
  }
  get(id: string): ReminderItem | undefined {
    const row = this.state.db.query("SELECT * FROM reminder_items WHERE id=?").get(id) as ReminderItemRow | null;
    return row ? itemFromRow(row) : undefined;
  }
  list(status: ReminderStatus | "all" = "active", limit = 500): ReminderItem[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Reminder list limit must be 1-500");
    const rows = status === "all"
      ? this.state.db.query(`
        SELECT * FROM reminder_items
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,
          deadline_local_date,importance DESC,id LIMIT ?
      `).all(limit)
      : this.state.db.query(`
        SELECT * FROM reminder_items WHERE status=?
        ORDER BY deadline_local_date,importance DESC,id LIMIT ?
      `).all(status, limit);
    return (rows as ReminderItemRow[]).map(itemFromRow);
  }
  complete(id: string, now = new Date().toISOString()): ReminderItem {
    return this.transition(id, "completed", validIso(now, "Reminder completed_at"));
  }
  reopen(id: string, now = new Date().toISOString()): ReminderItem {
    return this.transition(id, "active", validIso(now, "Reminder reopened_at"));
  }

  expireBefore(localDate: string, now = new Date().toISOString()): number {
    const timestamp = validIso(now, "Reminder expired_at");
    const result = this.state.db.query(`
      UPDATE reminder_items SET status='expired',expired_at=?,completed_at=NULL,updated_at=?
      WHERE status='active' AND deadline_local_date < ?
    `).run(timestamp, timestamp, assertLocalDate(localDate));
    return result.changes;
  }

  getDelivery(deliveryKey: string): ReminderDeliveryWindow | undefined {
    const row = this.state.db.query("SELECT * FROM reminder_delivery_windows WHERE delivery_key=?")
      .get(deliveryKey) as ReminderDeliveryRow | null;
    return row ? deliveryFromRow(row) : undefined;
  }

  recordDelivery(input: {
    delivery_key: string;
    reminder_id?: string;
    kind: ReminderDeliveryKind;
    local_date: string;
    slot: number;
    status: ReminderDeliveryStatus;
    result?: unknown;
    error?: string;
    now?: string;
  }): ReminderDeliveryWindow {
    const existing = this.getDelivery(input.delivery_key);
    if (existing && TERMINAL_DELIVERY.has(existing.status)) return existing;
    const now = validIso(input.now ?? new Date().toISOString(), "Reminder delivery timestamp");
    const resultJson = input.result === undefined ? null : boundedJson(input.result);
    const error = input.error ? safeError(input.error) : null;
    this.state.db.query(`
      INSERT INTO reminder_delivery_windows(
        delivery_key,reminder_id,kind,local_date,slot,status,attempts,
        result_json,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,1,?,?,?,?)
      ON CONFLICT(delivery_key) DO UPDATE SET
        status=excluded.status,
        attempts=reminder_delivery_windows.attempts+1,
        result_json=excluded.result_json,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at
    `).run(
      stableKey(input.delivery_key, "Reminder delivery key", 240),
      input.reminder_id ?? null,
      input.kind,
      assertLocalDate(input.local_date),
      input.slot,
      input.status,
      resultJson,
      error,
      now,
      now,
    );
    return this.getDelivery(input.delivery_key)!;
  }

  importLegacy(bundle: LegacyReminderImportBundle): LegacyReminderImportResult {
    validateImportBundle(bundle);
    let result: LegacyReminderImportResult = {
      applied: false, items: bundle.items.length, delivery_windows: bundle.deliveries.length,
    };
    this.state.db.transaction(() => {
      const prior = this.state.db.query(`
        SELECT payload_json FROM records WHERE namespace=? AND id=?
      `).get(IMPORT_NAMESPACE, bundle.source_ref) as { payload_json: string } | null;
      if (prior) {
        const value = JSON.parse(prior.payload_json) as { source_sha256?: string };
        if (value.source_sha256 !== bundle.source_sha256) {
          throw new Error(`Legacy reminder source changed after import: ${bundle.source_ref}`);
        }
        return;
      }
      for (const item of bundle.items) this.insertLegacyItem(item);
      for (const delivery of bundle.deliveries) this.insertLegacyDelivery(delivery);
      const now = new Date().toISOString();
      this.state.db.query(`
        INSERT INTO records(namespace,id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)
      `).run(IMPORT_NAMESPACE, bundle.source_ref, JSON.stringify({
        schema_version: 1,
        source_sha256: bundle.source_sha256,
        source_row_count: bundle.source_row_count,
        items: bundle.items.length,
        delivery_windows: bundle.deliveries.length,
        imported_at: now,
      }), now, now);
      result = { ...result, applied: true };
    })();
    return result;
  }

  private transition(id: string, status: "active" | "completed", now: string): ReminderItem {
    const existing = this.getRequired(id);
    if (existing.status === status) return existing;
    this.state.db.query(`
      UPDATE reminder_items SET status=?,completed_at=?,expired_at=NULL,updated_at=? WHERE id=?
    `).run(status, status === "completed" ? now : null, now, id);
    return this.getRequired(id);
  }

  private getRequired(id: string): ReminderItem {
    const reminder = this.get(id);
    if (!reminder) throw new Error(`Reminder not found: ${id}`);
    return reminder;
  }

  private insertLegacyItem(item: ReminderItem & { legacy_ref: string }): void {
    this.state.db.query(`
      INSERT INTO reminder_items(
        id,title,deadline_local_date,importance,status,legacy_ref,created_at,updated_at,
        completed_at,expired_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      stableKey(item.id, "Legacy reminder id", 100), assertReminderTitle(item.title),
      assertLocalDate(item.deadline_local_date), assertReminderImportance(item.importance),
      item.status, item.legacy_ref, validIso(item.created_at, "Legacy reminder created_at"),
      validIso(item.updated_at, "Legacy reminder updated_at"), item.completed_at ?? null,
      item.expired_at ?? null,
    );
  }

  private insertLegacyDelivery(delivery: ReminderDeliveryWindow & { legacy_ref: string }): void {
    this.state.db.query(`
      INSERT INTO reminder_delivery_windows(
        delivery_key,reminder_id,kind,local_date,slot,status,attempts,result_json,
        last_error,legacy_ref,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      stableKey(delivery.delivery_key, "Legacy delivery key", 240), delivery.reminder_id ?? null,
      delivery.kind, assertLocalDate(delivery.local_date), delivery.slot, delivery.status,
      delivery.attempts, delivery.result === undefined ? null : boundedJson(delivery.result),
      delivery.last_error ? safeError(delivery.last_error) : null, delivery.legacy_ref,
      validIso(delivery.created_at, "Legacy delivery created_at"),
      validIso(delivery.updated_at, "Legacy delivery updated_at"),
    );
  }
}

function itemFromRow(row: ReminderItemRow): ReminderItem {
  return {
    id: row.id, title: row.title, deadline_local_date: row.deadline_local_date,
    importance: row.importance as ReminderImportance, status: row.status,
    created_at: row.created_at, updated_at: row.updated_at,
    ...(row.completed_at ? { completed_at: row.completed_at } : {}),
    ...(row.expired_at ? { expired_at: row.expired_at } : {}),
    ...(row.legacy_ref ? { legacy_ref: row.legacy_ref } : {}),
  };
}

function deliveryFromRow(row: ReminderDeliveryRow): ReminderDeliveryWindow {
  return {
    delivery_key: row.delivery_key, kind: row.kind, local_date: row.local_date,
    slot: row.slot, status: row.status, attempts: row.attempts,
    created_at: row.created_at, updated_at: row.updated_at,
    ...(row.reminder_id ? { reminder_id: row.reminder_id } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    ...(row.legacy_ref ? { legacy_ref: row.legacy_ref } : {}),
  };
}

function validateImportBundle(bundle: LegacyReminderImportBundle): void {
  stableKey(bundle.source_ref, "Legacy reminder source_ref", 200);
  if (!/^[a-f0-9]{64}$/.test(bundle.source_sha256)) throw new Error("Legacy reminder SHA-256 is invalid");
  if (!Number.isSafeInteger(bundle.source_row_count) || bundle.source_row_count < 0) {
    throw new Error("Legacy reminder source row count is invalid");
  }
}

function stableKey(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validIso(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be ISO-8601`);
  return new Date(timestamp).toISOString();
}

function boundedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 64 * 1_024) {
    throw new Error("Reminder delivery result exceeds 65536 bytes");
  }
  return encoded;
}

function safeError(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 500);
}
