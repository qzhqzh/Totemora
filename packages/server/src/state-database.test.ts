import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "./state-database";

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
    CREATE TABLE skill_activations(id TEXT PRIMARY KEY,commission_id TEXT NOT NULL,skill_id TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL,target_member_id TEXT,target_service_id TEXT,package_json TEXT NOT NULL,status TEXT NOT NULL,approved_by TEXT NOT NULL,activated_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  `);
  const now = "2026-08-14T00:00:00.000Z";
  for (let version = 1; version <= 6; version += 1) {
    db.query("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, `existing-${version}`, now);
  }
  const pkg = {
    skill_id: "git-change-management", title: "Git Flow Release", description: "test",
    base_version: 4, version: 5, target_member_id: "deepseek_git_steward", target_service_id: "git.flow",
    risk: "repository_mutation", trigger: "test", instructions: ["one", "two"], boundaries: ["safe"],
    acceptance_examples: ["a", "b"], sources: [], requested_assets: [],
    skill_md: "---\nname: git-change-management\ndescription: test\n---\n", digest: "old", status: "active",
  };
  db.query("INSERT INTO skill_commissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("commission-1", "Git", "test", "active", "chief", "deepseek_git_steward", "git.flow", "repository_mutation", JSON.stringify(pkg), "old", 5, 1, now, now);
  db.query("INSERT INTO skill_activations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("activation-1", "commission-1", "git-change-management", 5, "old", "deepseek_git_steward", "git.flow", JSON.stringify(pkg), "active", "owner", now, now);
  db.query("INSERT INTO records VALUES(?,?,?,?,?)")
    .run("skill_overlays", "git-change-management", JSON.stringify({ skill_id: "git-change-management", base_version: 4, version: 5, additions: [], updated_at: now }), now, now);
  db.close();

  const state = StateDatabase.open(dataDir);
  const commission = state.db.query("SELECT package_json,package_digest FROM skill_commissions WHERE id=?").get("commission-1") as { package_json: string; package_digest: string };
  const migratedPackage = JSON.parse(commission.package_json) as typeof pkg;
  expect(migratedPackage.skill_id).toBe("git-flow-release");
  expect(migratedPackage.skill_md).toContain("name: git-flow-release");
  const normalized = { ...migratedPackage, digest: undefined, status: undefined };
  expect(commission.package_digest).toBe(createHash("sha256").update(JSON.stringify(normalized)).digest("hex"));
  expect(state.db.query("SELECT skill_id,digest FROM skill_activations WHERE id=?").get("activation-1"))
    .toEqual({ skill_id: "git-flow-release", digest: commission.package_digest });
  expect(state.listRecords<{ skill_id: string }>("skill_overlays")).toEqual([
    expect.objectContaining({ skill_id: "git-flow-release" }),
  ]);
  expect(state.db.query("SELECT 1 FROM records WHERE namespace='skill_overlays' AND id='git-change-management'").get()).toBeNull();
  await rm(dataDir, { recursive: true, force: true });
});
