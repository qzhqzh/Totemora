import { Database } from "bun:sqlite";

import {
  assertLocalDate,
  assertReminderImportance,
  assertReminderTitle,
  reminderDeliveryKey,
  type ReminderDeliveryStatus,
} from "../domains/reminder/reminder";
import {
  ReminderRepository,
  type LegacyReminderImportBundle,
} from "../repositories/reminder-repository";
import { sha256FrozenSqliteSnapshot } from "./frozen-sqlite-snapshot";

const MAX_SNAPSHOT_BYTES = 32 * 1_024 * 1_024;
const MAX_ACTIVE_ITEMS = 1_000;
const REQUIRED_SCHEMA = {
  items: ["id", "title", "deadline", "status", "created_at", "importance"],
  deliveries: ["local_date", "delivered_at", "item_count"],
  item_deliveries: [
    "item_id", "local_date", "slot", "delivered_at", "status", "attempts", "updated_at", "last_error",
  ],
} as const;

interface LegacyItemRow {
  id: number;
  title: string;
  deadline: string;
  status: string;
  created_at: string;
  importance: number;
}

interface LegacyDailyRow {
  local_date: string;
  delivered_at: string;
  item_count: number;
}

interface LegacyItemDeliveryRow {
  item_id: number;
  local_date: string;
  slot: number;
  delivered_at: string;
  status: string;
  attempts: number;
  updated_at: string | null;
  last_error: string | null;
}

export interface LegacyMemoImportReport {
  source_ref: string;
  source_sha256: string;
  source_row_count: number;
  local_date: string;
  active_items: number;
  daily_delivery_windows: number;
  item_delivery_windows: number;
  apply_requested: boolean;
  applied: boolean;
}

export async function importLegacyMemoSnapshot(input: {
  sourcePath: string;
  sourceRef: string;
  localDate: string;
  dataDir: string;
  apply: boolean;
}): Promise<LegacyMemoImportReport> {
  const localDate = assertLocalDate(input.localDate);
  const sha256 = await sha256FrozenSqliteSnapshot({
    sourcePath: input.sourcePath,
    label: "Legacy memo import",
    maximumBytes: MAX_SNAPSHOT_BYTES,
  });
  const bundle = buildImportBundle(input.sourcePath, input.sourceRef, localDate, sha256);
  const applied = input.apply
    ? new ReminderRepository(input.dataDir).importLegacy(bundle).applied
    : false;
  return {
    source_ref: bundle.source_ref,
    source_sha256: sha256,
    source_row_count: bundle.source_row_count,
    local_date: localDate,
    active_items: bundle.items.length,
    daily_delivery_windows: bundle.deliveries.filter((item) => item.kind === "daily_digest").length,
    item_delivery_windows: bundle.deliveries.filter((item) => item.kind === "escalation").length,
    apply_requested: input.apply,
    applied,
  };
}

function buildImportBundle(
  sourcePath: string,
  sourceRef: string,
  localDate: string,
  sha256: string,
): LegacyReminderImportBundle {
  const db = new Database(sourcePath, { readonly: true, strict: true });
  try {
    validateSchema(db);
    const sourceRowCount = Object.keys(REQUIRED_SCHEMA).reduce((total, table) => {
      const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return total + row.count;
    }, 0);
    const itemRows = db.query(`
      SELECT id,title,deadline,status,created_at,importance
      FROM items WHERE status='active' ORDER BY id LIMIT ?
    `).all(MAX_ACTIVE_ITEMS + 1) as LegacyItemRow[];
    if (itemRows.length > MAX_ACTIVE_ITEMS) {
      throw new Error(`Legacy memo snapshot exceeds ${MAX_ACTIVE_ITEMS} active items`);
    }
    const itemIds = new Set(itemRows.map((row) => row.id));
    const items = itemRows.map((row) => legacyItem(row, sourceRef));
    const dailyRows = db.query(`
      SELECT local_date,delivered_at,item_count FROM deliveries WHERE local_date=?
    `).all(localDate) as LegacyDailyRow[];
    const itemDeliveries = db.query(`
      SELECT d.item_id,d.local_date,d.slot,d.delivered_at,d.status,d.attempts,d.updated_at,d.last_error
      FROM item_deliveries d JOIN items i ON i.id=d.item_id
      WHERE d.local_date=? AND i.status='active' ORDER BY d.item_id,d.slot
    `).all(localDate) as LegacyItemDeliveryRow[];
    return {
      source_ref: sourceRef,
      source_sha256: sha256,
      source_row_count: sourceRowCount,
      items,
      deliveries: [
        ...dailyRows.map((row) => legacyDailyDelivery(row, sourceRef)),
        ...itemDeliveries.map((row) => legacyItemDelivery(row, sourceRef, itemIds)),
      ],
    };
  } finally {
    db.close();
  }
}

function legacyItem(row: LegacyItemRow, sourceRef: string): LegacyReminderImportBundle["items"][number] {
  if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error("Legacy memo item id is invalid");
  if (row.status !== "active") throw new Error("Legacy memo import only accepts active items");
  const timestamp = legacyTimestamp(row.created_at, "item created_at");
  return {
    id: `legacy-memo-${row.id}`,
    title: assertReminderTitle(row.title),
    deadline_local_date: assertLocalDate(row.deadline),
    importance: assertReminderImportance(row.importance),
    status: "active",
    legacy_ref: `${sourceRef}:item:${row.id}`,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function legacyDailyDelivery(
  row: LegacyDailyRow,
  sourceRef: string,
): LegacyReminderImportBundle["deliveries"][number] {
  const timestamp = legacyTimestamp(row.delivered_at, "daily delivered_at");
  return {
    delivery_key: reminderDeliveryKey({ kind: "daily_digest", local_date: row.local_date, slot: 10 }),
    kind: "daily_digest",
    local_date: assertLocalDate(row.local_date),
    slot: 10,
    status: "completed",
    attempts: 1,
    result: { legacy_status: "sent", item_count: boundedCount(row.item_count) },
    legacy_ref: `${sourceRef}:daily:${row.local_date}`,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function legacyItemDelivery(
  row: LegacyItemDeliveryRow,
  sourceRef: string,
  activeItemIds: Set<number>,
): LegacyReminderImportBundle["deliveries"][number] {
  if (!activeItemIds.has(row.item_id)) throw new Error("Legacy delivery references a non-active memo item");
  const status = legacyDeliveryStatus(row.status);
  const timestamp = legacyTimestamp(row.updated_at ?? row.delivered_at, "item delivery timestamp");
  const reminderId = `legacy-memo-${row.item_id}`;
  return {
    delivery_key: reminderDeliveryKey({
      kind: "escalation", reminder_id: reminderId, local_date: row.local_date, slot: row.slot,
    }),
    reminder_id: reminderId,
    kind: "escalation",
    local_date: assertLocalDate(row.local_date),
    slot: boundedSlot(row.slot),
    status,
    attempts: boundedCount(row.attempts),
    result: { legacy_status: row.status },
    ...(row.last_error ? { last_error: safeError(row.last_error) } : {}),
    legacy_ref: `${sourceRef}:item-delivery:${row.item_id}:${row.local_date}:${row.slot}`,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function validateSchema(db: Database): void {
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (required.some((column) => !columns.has(column))) {
      throw new Error(`Legacy memo snapshot has an unsupported ${table} schema`);
    }
  }
}

function legacyDeliveryStatus(value: string): ReminderDeliveryStatus {
  if (value === "sent") return "completed";
  if (value === "retry") return "failed";
  if (value === "publishing") return "uncertain";
  throw new Error("Legacy memo delivery status is unsupported");
}

function legacyTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`Legacy memo ${label} is invalid`);
  return new Date(timestamp).toISOString();
}

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Legacy memo count is invalid");
  return value;
}

function boundedSlot(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 23) throw new Error("Legacy memo slot is invalid");
  return value;
}

function safeError(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 500);
}
