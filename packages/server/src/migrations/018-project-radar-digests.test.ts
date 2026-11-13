import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyProjectRadarDigestsMigration } from "./018-project-radar-digests";

test("migration 18 preserves the pre-upgrade candidates and records, constrains new state, and repeats safely", () => {
  const db = version17Fixture();
  try {
    applyProjectRadarDigestsMigration(db);
    applyProjectRadarDigestsMigration(db);
    expect(db.query("SELECT * FROM intelligence_candidates").all()).toEqual([{ id: "old-candidate", status: "queued" }]);
    expect(db.query("SELECT payload_json FROM records").get()).toEqual({ payload_json: '{"keep":true}' });
    expect(db.query("SELECT COUNT(*) count FROM schema_migrations WHERE version=18").get()).toEqual({ count: 1 });
    const insert = db.query(`INSERT INTO project_radar_digests(day,status,attempts,payload_json,created_at,updated_at)
      VALUES('2026-09-22',?,0,?,'2026-09-22','2026-09-22')`);
    const payload = JSON.stringify({ date: "2026-09-22", items: [] });
    expect(() => insert.run("invalid", payload)).toThrow();
    expect(() => insert.run("sending", payload)).toThrow();
    expect(() => insert.run("empty", "{}")).toThrow();
    insert.run("empty", payload);
    const item = db.query("INSERT INTO project_radar_digest_items VALUES(?,?,?)");
    expect(() => item.run("missing-candidate", "2026-09-22", "queued")).toThrow();
    expect(() => item.run("old-candidate", "2026-09-23", "queued")).toThrow();
    expect(() => item.run("old-candidate", "2026-09-22", "pushed")).toThrow();
    item.run("old-candidate", "2026-09-22", "queued");
    expect(() => item.run("old-candidate", "2026-09-22", "queued")).toThrow();
    expect(() => db.query("INSERT INTO project_radar_runtime(id) VALUES(2)").run()).toThrow();
  } finally { db.close(); }
});

test("migration 18 rolls all DDL and its version back when registration fails", () => {
  const db = version17Fixture();
  try {
    db.exec("CREATE TRIGGER fail_18 BEFORE INSERT ON schema_migrations WHEN NEW.version=18 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    expect(() => applyProjectRadarDigestsMigration(db)).toThrow("fixture failure");
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'project_radar_digest%' OR name='project_radar_runtime'").all()).toEqual([]);
    expect(db.query("SELECT version FROM schema_migrations WHERE version=18").get()).toBeNull();
    expect(db.query("SELECT status FROM intelligence_candidates").get()).toEqual({ status: "queued" });
    db.exec("DROP TRIGGER fail_18");
    applyProjectRadarDigestsMigration(db);
    expect(db.query("SELECT id FROM project_radar_runtime").get()).toEqual({ id: 1 });
  } finally { db.close(); }
});

function version17Fixture(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    CREATE TABLE intelligence_candidates(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    INSERT INTO intelligence_candidates VALUES('old-candidate','queued');
    CREATE TABLE records(namespace TEXT,id TEXT,payload_json TEXT);
    INSERT INTO records VALUES('fixture','old-record','{"keep":true}');`);
  for (let version = 1; version <= 17; version++) db.query("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, `existing-${version}`, "2026-09-21");
  return db;
}
