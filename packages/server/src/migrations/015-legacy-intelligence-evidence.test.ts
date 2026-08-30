import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { runStateMigrations } from ".";

test("migration 15 preserves version 14 state and constrains legacy evidence", () => {
  const db = version14Fixture();
  try {
    runStateMigrations(db);
    runStateMigrations(db);
    expect(db.query("SELECT payload_json FROM records WHERE namespace='fixture'").get())
      .toEqual({ payload_json: '{"value":15}' });
    expect(db.query("SELECT name FROM schema_migrations WHERE version=15").get())
      .toEqual({ name: "legacy intelligence delivery evidence" });
    db.query(`
      INSERT INTO legacy_intelligence_imports(
        source_ref,domain,source_sha256,source_row_count,seed_count,imported_at
      ) VALUES('legacy:ai','ai',?,1,1,'2026-08-30')
    `).run("a".repeat(64));
    db.query(`
      INSERT INTO legacy_intelligence_evidence(
        legacy_ref,domain,source_ref,source,url,headline,delivered_at
      ) VALUES('legacy:ai:e1','ai','legacy:ai','hn','https://example.com/a','Headline','2026-08-30')
    `).run();
    expect(() => db.query(`
      INSERT INTO legacy_intelligence_evidence(
        legacy_ref,domain,source_ref,source,url,headline,delivered_at
      ) VALUES('legacy:ai:e2','finance','legacy:ai','hn','https://example.com/b','Other','2026-08-30')
    `).run()).toThrow();
    expect(() => db.query(`
      INSERT INTO legacy_intelligence_imports(
        source_ref,domain,source_sha256,source_row_count,seed_count,imported_at
      ) VALUES('legacy:bad','content',?,0,0,'2026-08-30')
    `).run("b".repeat(64))).toThrow();
  } finally { db.close(); }
});

test("migration 15 rolls back all evidence schema when its version record fails", () => {
  const db = version14Fixture();
  try {
    db.exec(`
      CREATE TRIGGER reject_migration_15 BEFORE INSERT ON schema_migrations
      WHEN NEW.version=15 BEGIN SELECT RAISE(ABORT,'simulated evidence migration failure'); END;
    `);
    expect(() => runStateMigrations(db)).toThrow("simulated evidence migration failure");
    expect(db.query("SELECT version FROM schema_migrations WHERE version=15").get()).toBeNull();
    expect(db.query(`
      SELECT name FROM sqlite_master WHERE name LIKE 'legacy_intelligence_%' ORDER BY name
    `).all()).toEqual([]);
    db.exec("DROP TRIGGER reject_migration_15");
    runStateMigrations(db);
    expect(db.query(`
      SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'legacy_intelligence_%' ORDER BY name
    `).all()).toEqual([
      { name: "legacy_intelligence_evidence" },
      { name: "legacy_intelligence_imports" },
    ]);
  } finally { db.close(); }
});

function version14Fixture(): Database {
  const db = new Database(":memory:", { create: true, strict: true });
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    CREATE TABLE records(
      namespace TEXT NOT NULL,id TEXT NOT NULL,payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(namespace,id)
    );
    INSERT INTO records VALUES('fixture','keep','{"value":15}','2026-08-01','2026-08-01');
  `);
  for (let version = 1; version <= 14; version += 1) {
    db.query("INSERT INTO schema_migrations VALUES(?,?,?)")
      .run(version, `existing-${version}`, "2026-08-01");
  }
  return db;
}
