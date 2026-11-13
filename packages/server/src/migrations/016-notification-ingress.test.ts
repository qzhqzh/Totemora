import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runStateMigrations } from ".";

test("migration 16 preserves v15 data, enforces identity and valid states, and is idempotent", () => {
  const db = version15Fixture();
  try {
    runStateMigrations(db);
    runStateMigrations(db);
    expect(db.query("SELECT payload_json FROM records WHERE namespace='fixture'").get())
      .toEqual({ payload_json: '{"value":16}' });
    expect(db.query("SELECT name FROM schema_migrations WHERE version=16").get())
      .toEqual({ name: "authenticated external notification inbox" });
    const values = ["uuid-1", "backup", "e1", "backup.failed", "a".repeat(64), "Failure", "body", 4,
      "2026-08-30", "[]", "unrouted", "2026-08-30", "2026-08-30"];
    const insert = db.query(`
      INSERT INTO external_notification_events(
        event_uuid,source_id,external_id,type,payload_hash,title,body,priority,occurred_at,
        route_targets_json,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    insert.run(...values);
    expect(() => insert.run("uuid-2", ...values.slice(1))).toThrow();
    expect(() => insert.run("uuid-2", ...values.slice(1, 10), "sent", ...values.slice(11))).toThrow();
  } finally { db.close(); }
});

test("migration 16 rolls back table, indexes and version atomically on failure", () => {
  const db = version15Fixture();
  try {
    db.exec(`CREATE TRIGGER reject_16 BEFORE INSERT ON schema_migrations
      WHEN NEW.version=16 BEGIN SELECT RAISE(ABORT,'blocked'); END;`);
    expect(() => runStateMigrations(db)).toThrow("blocked");
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'external_notification_%'").all()).toEqual([]);
    expect(db.query("SELECT version FROM schema_migrations WHERE version=16").get()).toBeNull();
    db.exec("DROP TRIGGER reject_16");
    runStateMigrations(db);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='external_notification_events'").get())
      .toEqual({ name: "external_notification_events" });
  } finally { db.close(); }
});

function version15Fixture(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    CREATE TABLE records(namespace TEXT NOT NULL,id TEXT NOT NULL,payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(namespace,id));
    INSERT INTO records VALUES('fixture','keep','{"value":16}','2026-08-01','2026-08-01');
  `);
  for (let version = 1; version <= 15; version += 1) {
    db.query("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, `existing-${version}`, "2026-08-01");
  }
  return db;
}
