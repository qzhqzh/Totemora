import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "./state-database";
import { runStateMigrations } from "./migrations";

test("state migrations register every version and remain idempotent", () => {
  const db = new Database(":memory:", { create: true, strict: true });
  try {
    runStateMigrations(db);
    runStateMigrations(db);
    expect(db.query("SELECT version,name FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, name: "initial durable tribe state" },
      { version: 2, name: "domain-aware intelligence candidates" },
      { version: 3, name: "conversational skill commissions" },
      { version: 4, name: "skill commission optimistic concurrency" },
      { version: 5, name: "skill trial active run reservation" },
      { version: 6, name: "skill trial lease fencing" },
      { version: 7, name: "rename git flow Skill canonical id" },
      { version: 8, name: "constrain skill trial outcomes" },
    ]);
  } finally {
    db.close();
  }
});

test("legacy JSON import is idempotent and refuses silent post-cutover changes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-state-migration-"));
  const source = join(dataDir, "legacy.json");
  await writeFile(source, JSON.stringify([{ id: "one" }, { id: "two" }]));
  const state = StateDatabase.open(dataDir);
  const insert = (value: { id: string }) => state.putRecord("migration_test", value.id, value);
  expect(state.importJsonFile(source, (value) => value as Array<{ id: string }>, insert)).toEqual({
    imported: true, row_count: 2,
  });
  expect(state.importJsonFile(source, (value) => value as Array<{ id: string }>, insert)).toEqual({
    imported: false, row_count: 2,
  });
  expect(state.listRecords("migration_test")).toHaveLength(2);
  await writeFile(source, JSON.stringify([{ id: "changed" }]));
  expect(() => state.importJsonFile(source, (value) => value as Array<{ id: string }>, insert))
    .toThrow("changed after SQLite cutover");
  await rm(dataDir, { recursive: true, force: true });
});

test("migration 7 renames the Git Flow Skill id without losing governance history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-id-migration-"));
  const path = join(dataDir, "totemora.db");
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    CREATE TABLE records(namespace TEXT NOT NULL,id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(namespace,id));
    CREATE TABLE skill_commissions(id TEXT PRIMARY KEY,title TEXT NOT NULL,goal TEXT NOT NULL,status TEXT NOT NULL,chief_member_id TEXT NOT NULL,target_member_id TEXT,target_service_id TEXT,risk TEXT NOT NULL,package_json TEXT,package_digest TEXT,package_version INTEGER,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE skill_trials(id TEXT PRIMARY KEY,commission_id TEXT NOT NULL,baseline_evidence_id TEXT NOT NULL,trial_evidence_id TEXT NOT NULL,reviewer_member_id TEXT NOT NULL,outcome TEXT NOT NULL,metrics_json TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(commission_id,trial_evidence_id));
    CREATE TABLE skill_activations(id TEXT PRIMARY KEY,commission_id TEXT NOT NULL,skill_id TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL,target_member_id TEXT,target_service_id TEXT,package_json TEXT NOT NULL,status TEXT NOT NULL,approved_by TEXT NOT NULL,activated_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  `);
  const now = "2026-08-14T00:00:00.000Z";
  for (let version = 1; version <= 6; version += 1) {
    db.query("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, `existing-${version}`, now);
  }
  const pkg = {
    skill_id: "git-change-management", title: "Git Flow Release", description: "test",
    base_version: 3, version: 4, target_member_id: "deepseek_git_steward", target_service_id: "git.flow",
    risk: "repository_mutation", trigger: "test", instructions: ["one", "two"], boundaries: ["safe"],
    acceptance_examples: ["a", "b"], sources: [], requested_assets: [],
    skill_md: "---\nname: git-change-management\ndescription: test\n---\n", digest: "old", status: "active",
  };
  db.query("INSERT INTO skill_commissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("commission-1", "Git", "test", "active", "chief", "deepseek_git_steward", "git.flow", "repository_mutation", JSON.stringify(pkg), "old", 5, 1, now, now);
  db.query("INSERT INTO skill_activations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("activation-1", "commission-1", "git-change-management", 4, "old", "deepseek_git_steward", "git.flow", JSON.stringify(pkg), "active", "owner", now, now);
  db.query("INSERT INTO records VALUES(?,?,?,?,?)")
    .run("skill_overlays", "git-change-management", JSON.stringify({
      skill_id: "git-change-management", version: 4,
      additions: ["preserve approved rule"], updated_at: now,
    }), now, now);
  db.query("INSERT INTO skill_trials VALUES(?,?,?,?,?,?,?,?,?)")
    .run("legacy-invalid", "commission-1", "base", "trial", "reviewer", "maybe", "{}", "legacy bad outcome", now);
  db.close();

  const state = StateDatabase.open(dataDir);
  const commission = state.db.query("SELECT status,package_json,package_digest FROM skill_commissions WHERE id=?").get("commission-1") as {
    status: string; package_json: string; package_digest: string;
  };
  const migratedPackage = JSON.parse(commission.package_json) as typeof pkg;
  expect(migratedPackage.skill_id).toBe("git-flow-release");
  expect(migratedPackage.skill_md).toContain("name: git-flow-release");
  expect(migratedPackage.status).toBe("superseded");
  expect(commission.status).toBe("superseded");
  const normalized = { ...migratedPackage, digest: undefined, status: undefined };
  expect(commission.package_digest).toBe(createHash("sha256").update(JSON.stringify(normalized)).digest("hex"));
  expect(state.db.query("SELECT skill_id,digest,status FROM skill_activations WHERE id=?").get("activation-1"))
    .toEqual({ skill_id: "git-flow-release", digest: commission.package_digest, status: "superseded" });
  expect(state.listRecords<{ skill_id: string }>("skill_overlays")).toEqual([
    expect.objectContaining({
      skill_id: "git-flow-release", base_version: 4, version: 5,
      additions: ["preserve approved rule"],
    }),
  ]);
  expect(state.db.query("SELECT 1 FROM records WHERE namespace='skill_overlays' AND id='git-change-management'").get()).toBeNull();
  expect(state.db.query("SELECT 1 FROM skill_trials WHERE id='legacy-invalid'").get()).toBeNull();
  const quarantined = state.db.query(`
    SELECT payload_json FROM records WHERE namespace='quarantined_skill_trials' AND id='legacy-invalid'
  `).get() as { payload_json: string };
  expect(JSON.parse(quarantined.payload_json)).toMatchObject({
    reason: "invalid_outcome_before_migration_8",
    trial: { id: "legacy-invalid", outcome: "maybe" },
  });
  expect(() => state.db.query(`
    INSERT INTO skill_trials VALUES(?,?,?,?,?,?,?,?,?)
  `).run("invalid", "commission-1", "base", "trial", "reviewer", "maybe", "{}", "bad", now))
    .toThrow("invalid skill trial outcome");
  await rm(dataDir, { recursive: true, force: true });
});
