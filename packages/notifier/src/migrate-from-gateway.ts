import { Database } from "bun:sqlite";
import { resolve } from "node:path";

import { NotifierDatabase } from "./storage";

const EVENT_COLUMNS = [
  "event_uuid", "source_id", "external_id", "type", "payload_hash", "title", "body", "priority", "occurred_at",
  "dedupe_key", "coalesced_by", "route_targets_json", "status", "attempts", "result_json", "last_error", "created_at", "updated_at",
] as const;
const ACTION_COLUMNS = [
  "id", "idempotency_key", "asset_id", "member_id", "action", "request_hash", "status", "attempts",
  "lease_token", "lease_expires_at", "started_at", "updated_at", "evidence", "error",
] as const;

type Row = Record<string, string | number | null>;

/** Execute only after the old sender stops. A failed import rolls back the entire target transaction. */
export function migrateGatewayNotifications(input: { sourcePath: string; dataDir: string; apply?: boolean }) {
  const sourcePath = resolve(input.sourcePath);
  const targetPath = resolve(input.dataDir, "notifier.db");
  if (sourcePath === targetPath) throw new Error("Source and Notifier databases must differ");
  const source = new Database(sourcePath, { readonly: true, strict: true });
  try {
    const table = (name: string) => Boolean(source.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const events = table("external_notification_events")
      ? source.query(`SELECT ${EVENT_COLUMNS.join(",")} FROM external_notification_events ORDER BY created_at,event_uuid`).all() as Row[] : [];
    const actions = table("action_journal")
      ? source.query(`SELECT ${ACTION_COLUMNS.join(",")} FROM action_journal WHERE idempotency_key LIKE 'notification:%' ORDER BY started_at,id`).all() as Row[] : [];
    const report = { events: events.length, actions: actions.length, applied: Boolean(input.apply) };
    if (!input.apply) return report;
    const target = NotifierDatabase.open(input.dataDir).db;
    const insert = (name: string, columns: readonly string[], rows: Row[], convert: (row: Row) => Row) => {
      const statement = target.prepare(`INSERT OR IGNORE INTO ${name}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
      for (const original of rows) {
        const row = convert(original);
        const result = statement.run(...columns.map((column) => row[column] ?? null));
        if (result.changes === 0) {
          const key = name === "action_journal" ? "idempotency_key" : "event_uuid";
          const current = target.query(`SELECT ${columns.join(",")} FROM ${name} WHERE ${key}=?`)
            .get(row[key]) as Row | null;
          if (!current || columns.some((column) => current[column] !== (row[column] ?? null))) {
            throw new Error(`Notifier import conflicts with existing ${name} record`);
          }
        }
      }
    };
    target.transaction(() => {
      target.exec("PRAGMA defer_foreign_keys = ON");
      insert("external_notification_events", EVENT_COLUMNS, events, (row) => row.status === "sending"
        ? { ...row, status: "uncertain", last_error: "Interrupted during Gateway-to-Notifier cutover" } : row);
      insert("action_journal", ACTION_COLUMNS, actions, (row) => row.status === "executing"
        ? { ...row, status: "uncertain", lease_token: null, lease_expires_at: null,
          error: "Interrupted during Gateway-to-Notifier cutover" } : row);
    })();
    return report;
  } finally { source.close(); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (key: string) => args[args.indexOf(key) + 1];
  const sourcePath = option("--source");
  const dataDir = option("--data-dir");
  if (!args.includes("--source") || !args.includes("--data-dir") || !sourcePath || !dataDir
    || args.some((arg) => arg.startsWith("--") && !["--source", "--data-dir", "--apply"].includes(arg))) {
    throw new Error("Usage: bun run packages/notifier/src/migrate-from-gateway.ts --source /path/totemora.db --data-dir /path/notifier-data [--apply]");
  }
  console.log(JSON.stringify(migrateGatewayNotifications({ sourcePath, dataDir, apply: args.includes("--apply") })));
}
