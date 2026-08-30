import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DealRepository } from "../repositories/deal-repository";
import { importLegacyDealsSnapshot } from "./legacy-deals-importer";

test("legacy deals importer dry-runs and imports terminal dedupe seeds exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-legacy-deals-"));
  const sourcePath = join(root, "deals-snapshot.db");
  const dataDir = join(root, "target");
  createFixture(sourcePath);
  try {
    const input = { sourcePath, sourceRef: "notice-ntfy:deals:test", dataDir };
    await expect(importLegacyDealsSnapshot({ ...input, apply: false })).resolves.toMatchObject({
      source_row_count: 4, items: 3, delivered_seeds: 1, skipped_seeds: 2,
      apply_requested: false, applied: false, inserted_items: 0,
    });
    expect(new DealRepository(dataDir).list()).toHaveLength(0);
    await expect(importLegacyDealsSnapshot({ ...input, apply: true })).resolves.toMatchObject({
      applied: true, inserted_items: 3,
    });
    const repository = new DealRepository(dataDir);
    expect(repository.summary().counts).toEqual({ pending: 0, delivered: 1, uncertain: 0, skipped: 2 });
    expect(repository.list("all", 10).some((item) => item.image_url?.startsWith("http://"))).toBe(false);
    await expect(importLegacyDealsSnapshot({ ...input, apply: true })).resolves
      .toMatchObject({ applied: false, inserted_items: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy deals importer refuses live WAL and unsupported schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-legacy-deals-safety-"));
  const sourcePath = join(root, "deals.db");
  createFixture(sourcePath);
  try {
    await writeFile(`${sourcePath}-wal`, "active");
    await expect(importLegacyDealsSnapshot({
      sourcePath, sourceRef: "notice-ntfy:deals:test", dataDir: join(root, "target"), apply: false,
    })).rejects.toThrow("frozen SQLite backup");
    await rm(`${sourcePath}-wal`);
    const malformedPath = join(root, "malformed.db");
    const malformed = new Database(malformedPath, { create: true });
    malformed.exec("CREATE TABLE items(source_id TEXT PRIMARY KEY)");
    malformed.close();
    await expect(importLegacyDealsSnapshot({
      sourcePath: malformedPath, sourceRef: "notice-ntfy:deals:test", dataDir: join(root, "target"), apply: false,
    })).rejects.toThrow("unsupported items schema");
    await expect(importLegacyDealsSnapshot({
      sourcePath, sourceRef: "bad ref", dataDir: join(root, "target"), apply: false,
    })).rejects.toThrow("source_ref is invalid");
  } finally { await rm(root, { recursive: true, force: true }); }
});

function createFixture(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE items(
      source_id TEXT PRIMARY KEY,title TEXT NOT NULL,deal TEXT,mall TEXT,url TEXT NOT NULL,
      image TEXT,discovered_at TEXT NOT NULL,source_rank INTEGER NOT NULL,status TEXT NOT NULL
    );
    CREATE TABLE runs(
      id INTEGER PRIMARY KEY,kind TEXT,started_at TEXT,finished_at TEXT,status TEXT,detail TEXT
    );
    INSERT INTO items VALUES
      ('1','Sent','9.9','Mall','https://example.com/1','https://img.example/1.jpg','2026-08-30T08:00:00+08:00',1,'sent'),
      ('2','Skipped','19.9','Mall','https://example.com/2','http://img.example/2.jpg','2026-08-30T09:00:00+08:00',2,'skipped'),
      ('3','Pending','29.9','Mall','https://example.com/3','https://img.example/3.jpg','2026-08-30T10:00:00+08:00',3,'pending');
    INSERT INTO runs VALUES(1,'collect_deals','2026-08-30','2026-08-30','success','ok');
  `);
  db.close();
}
