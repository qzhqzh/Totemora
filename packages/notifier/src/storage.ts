import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const instances = new Map<string, NotifierDatabase>();

/** Notifier owns a separate SQLite database; no Gateway tables are writable here. */
export class NotifierDatabase {
  readonly db: Database;

  static open(dataDir: string): NotifierDatabase {
    const path = resolve(dataDir, "notifier.db");
    let instance = instances.get(path);
    if (!instance) {
      instance = new NotifierDatabase(path);
      instances.set(path, instance);
    }
    return instance;
  }

  private constructor(readonly path: string) {
    mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    // A 202 acknowledges a durable record, not just an in-memory WAL append.
    this.db.exec("PRAGMA synchronous = FULL");
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
  }

  private migrate(): void {
    this.db.transaction(() => {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
      if (this.db.query("SELECT version FROM schema_migrations WHERE version=1").get()) return;
      this.db.exec(`
        CREATE TABLE external_notification_events(
          event_uuid TEXT PRIMARY KEY,
          source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 64),
          external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 128),
          type TEXT NOT NULL CHECK(length(type) BETWEEN 1 AND 100),
          payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
          title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
          body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 12000),
          priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5),
          occurred_at TEXT NOT NULL,
          dedupe_key TEXT CHECK(dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 128),
          coalesced_by TEXT REFERENCES external_notification_events(event_uuid),
          route_targets_json TEXT NOT NULL CHECK(json_valid(route_targets_json) AND json_type(route_targets_json)='array'),
          status TEXT NOT NULL CHECK(status IN ('pending','unrouted','coalesced','sending','completed','failed','uncertain')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
          last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 500),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(source_id,external_id)
        );
        CREATE INDEX external_notification_events_queue_idx
          ON external_notification_events(status,created_at,event_uuid);
        CREATE INDEX external_notification_events_coalesce_idx
          ON external_notification_events(source_id,type,dedupe_key,created_at)
          WHERE dedupe_key IS NOT NULL;
        CREATE TABLE action_journal(
          id TEXT PRIMARY KEY,
          idempotency_key TEXT UNIQUE NOT NULL,
          asset_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          action TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('executing','completed','failed','uncertain')),
          attempts INTEGER NOT NULL CHECK(attempts >= 1),
          lease_token TEXT,
          lease_expires_at TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          evidence TEXT,
          error TEXT
        );
      `);
      this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,?,?)")
        .run("isolated notifier inbox and delivery journal", new Date().toISOString());
    })();
  }
}
