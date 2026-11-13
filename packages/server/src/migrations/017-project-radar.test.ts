import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyProjectRadarMigration } from "./017-project-radar";

test("migration 17 preserves pre-upgrade rows, validates states and is repeatable", () => {
  const db = fixture();
  try {
    applyProjectRadarMigration(db);
    applyProjectRadarMigration(db);
    expect(db.query("SELECT payload_json FROM records").get()).toEqual({ payload_json: '{"value":"keep"}' });
    expect(db.query("SELECT COUNT(*) count FROM schema_migrations WHERE version=17").get()).toEqual({ count: 1 });
    const insert = db.query("INSERT INTO project_radar_settings VALUES(1,?,?,?)");
    expect(() => insert.run("enabled", '{"version":1,"mode":"enabled"}', "now")).toThrow();
    expect(() => insert.run("off", '{"version":1,"mode":"active"}', "now")).toThrow();
    insert.run("off", '{"version":1,"mode":"off"}', "now");
    expect(() => db.query(`INSERT INTO project_radar_usage VALUES('r','2026-09-22',?,'candidate','unknown',2,2,NULL,'now',NULL)`)
      .run("a".repeat(64))).toThrow();
    expect(() => db.query(`INSERT INTO project_radar_evaluations VALUES('e','candidate','send',?,?,?,'now')`)
      .run("a".repeat(64), "b".repeat(64), '{"route":"send"}')).toThrow();
  } finally { db.close(); }
});

test("migration 17 rolls back all new tables and retries safely", () => {
  const db = fixture();
  try {
    db.exec("CREATE TRIGGER fail17 BEFORE INSERT ON schema_migrations WHEN NEW.version=17 BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    expect(() => applyProjectRadarMigration(db)).toThrow("blocked");
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'project_radar_%'").all()).toEqual([]);
    expect(db.query("SELECT version FROM schema_migrations WHERE version=17").get()).toBeNull();
    expect(db.query("SELECT id FROM intelligence_candidates").get()).toEqual({ id: "candidate" });
    db.exec("DROP TRIGGER fail17");
    applyProjectRadarMigration(db);
    expect(db.query("SELECT COUNT(*) count FROM schema_migrations").get()).toEqual({ count: 17 });
  } finally { db.close(); }
});
function fixture(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
    CREATE TABLE intelligence_candidates(id TEXT PRIMARY KEY);
    INSERT INTO intelligence_candidates VALUES('candidate');
    CREATE TABLE records(namespace TEXT,id TEXT,payload_json TEXT);
    INSERT INTO records VALUES('fixture','keep','{"value":"keep"}');`);
  for (let version = 1; version <= 16; version += 1) db.query("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, `existing-${version}`, "2026-09-22");
  return db;
}
