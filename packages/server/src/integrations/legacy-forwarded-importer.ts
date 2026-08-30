import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { normalizeForwardedEvent } from "../domains/forwarded/forwarded-event";
import { ForwardedRepository, type LegacyForwardedImportBundle } from "../repositories/forwarded-repository";
import { sha256FrozenSqliteSnapshot } from "./frozen-sqlite-snapshot";

const MAX_SNAPSHOT_BYTES = 128 * 1_024 * 1_024;
const MAX_EVENTS = 5_000;
const REQUIRED_COLUMNS = ["id", "topic", "time", "title", "message", "priority", "tags", "click", "icon"];

interface LegacyMessageRow {
  id: string;
  time: number;
  title: string;
  message: string;
  priority: number;
  tags: string;
  click: string;
  icon: string;
}

export interface LegacyForwardedImportReport {
  source_ref: string;
  source_sha256: string;
  source_row_count: number;
  forwarded_events: number;
  cursor_time: number;
  apply_requested: boolean;
  applied: boolean;
  inserted_events: number;
}

export async function importLegacyForwardedSnapshot(input: {
  sourcePath: string;
  sourceRef: string;
  dataDir: string;
  apply: boolean;
}): Promise<LegacyForwardedImportReport> {
  validateSourceRef(input.sourceRef);
  const sha256 = await sha256FrozenSqliteSnapshot({
    sourcePath: input.sourcePath,
    label: "Legacy forwarded import",
    maximumBytes: MAX_SNAPSHOT_BYTES,
  });
  const bundle = buildBundle(input.sourcePath, input.sourceRef, sha256);
  const result = input.apply
    ? new ForwardedRepository(input.dataDir).importLegacy(bundle)
    : { applied: false, inserted_events: 0 };
  return {
    source_ref: bundle.source_ref,
    source_sha256: sha256,
    source_row_count: bundle.source_row_count,
    forwarded_events: bundle.events.length,
    cursor_time: bundle.cursor_time,
    apply_requested: input.apply,
    applied: result.applied,
    inserted_events: result.inserted_events,
  };
}

function buildBundle(sourcePath: string, sourceRef: string, sha256: string): LegacyForwardedImportBundle {
  const db = new Database(sourcePath, { readonly: true, strict: true });
  try {
    validateSchema(db);
    const sourceRowCount = (db.query("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count;
    const rows = db.query(`
      SELECT id,time,title,message,priority,tags,click,icon FROM messages
      WHERE topic='forwarded' ORDER BY time,id LIMIT ?
    `).all(MAX_EVENTS + 1) as LegacyMessageRow[];
    if (rows.length > MAX_EVENTS) throw new Error(`Legacy forwarded snapshot exceeds ${MAX_EVENTS} events`);
    return {
      source_ref: sourceRef,
      source_sha256: sha256,
      source_row_count: sourceRowCount,
      cursor_time: rows.reduce((maximum, row) => Math.max(maximum, integer(row.time, "time")), 0),
      events: rows.map((row) => legacyEvent(row, sourceRef)),
    };
  } finally { db.close(); }
}

function legacyEvent(row: LegacyMessageRow, sourceRef: string): LegacyForwardedImportBundle["events"][number] {
  const event = normalizeForwardedEvent({
    source_id: "legacy-forwarded",
    source_message_id: row.id,
    occurred_at: new Date(integer(row.time, "time") * 1_000).toISOString(),
    title: originalTitle(row.title),
    body: row.message,
    priority: integer(row.priority, "priority"),
    tags: parseTags(row.tags).filter((tag) => tag !== "outbox_tray"),
    ...(row.click?.startsWith("https://") ? { click_url: row.click } : {}),
    ...(row.icon?.startsWith("https://") ? { image_url: row.icon } : {}),
  });
  return {
    ...event,
    legacy_ref: `${sourceRef}:message:${createHash("sha256").update(row.id).digest("hex").slice(0, 24)}`,
    result: { legacy_status: "completed", legacy_topic: "forwarded" },
  };
}

function originalTitle(value: string): string {
  const title = value.trim();
  if (title === "↗️ 转发") return "";
  return title.startsWith("↗️ 转发｜") ? title.slice("↗️ 转发｜".length).trim() : title;
}
function parseTags(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Legacy forwarded tags are invalid JSON"); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Legacy forwarded tags must be a string array");
  }
  return parsed;
}
function validateSchema(db: Database): void {
  const columns = new Set((db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (REQUIRED_COLUMNS.some((column) => !columns.has(column))) {
    throw new Error("Legacy forwarded snapshot has an unsupported messages schema");
  }
}
function validateSourceRef(value: string): void {
  if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error("Legacy forwarded source_ref is invalid");
  }
}
function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Legacy forwarded ${label} is invalid`);
  return value;
}
