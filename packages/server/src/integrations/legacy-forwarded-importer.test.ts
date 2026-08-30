import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ForwardedRepository } from "../repositories/forwarded-repository";
import { importLegacyForwardedSnapshot } from "./legacy-forwarded-importer";

test("legacy forwarded importer preserves relay metadata and cursor exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-legacy-forwarded-"));
  const sourcePath = join(root, "history.db");
  const dataDir = join(root, "target");
  createFixture(sourcePath);
  try {
    const input = { sourcePath, sourceRef: "notice-ntfy:forwarded:test", dataDir };
    await expect(importLegacyForwardedSnapshot({ ...input, apply: false })).resolves.toMatchObject({
      source_row_count: 3, forwarded_events: 2, cursor_time: 102,
      apply_requested: false, applied: false, inserted_events: 0,
    });
    await expect(importLegacyForwardedSnapshot({ ...input, apply: true })).resolves.toMatchObject({
      applied: true, inserted_events: 2,
    });
    const repository = new ForwardedRepository(dataDir);
    expect(repository.list()).toEqual([
      expect.objectContaining({ title: "", body: "Second", priority: 3, tags: [] }),
      expect.objectContaining({ title: "Original", body: "First", priority: 4, tags: ["warning"] }),
    ]);
    expect(repository.sourceState("legacy-forwarded")?.cursor_time).toBe(102);
    await expect(importLegacyForwardedSnapshot({ ...input, apply: true })).resolves
      .toMatchObject({ applied: false, inserted_events: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy forwarded importer refuses active WAL and malformed history schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-legacy-forwarded-safety-"));
  const sourcePath = join(root, "history.db");
  createFixture(sourcePath);
  try {
    await writeFile(`${sourcePath}-wal`, "active");
    await expect(importLegacyForwardedSnapshot({
      sourcePath, sourceRef: "notice-ntfy:forwarded:test", dataDir: join(root, "target"), apply: false,
    })).rejects.toThrow("frozen SQLite backup");
    await rm(`${sourcePath}-wal`);
    const malformedPath = join(root, "malformed.db");
    const malformed = new Database(malformedPath, { create: true });
    malformed.exec("CREATE TABLE messages(id TEXT PRIMARY KEY)");
    malformed.close();
    await expect(importLegacyForwardedSnapshot({
      sourcePath: malformedPath, sourceRef: "notice-ntfy:forwarded:test", dataDir: join(root, "target"), apply: false,
    })).rejects.toThrow("unsupported messages schema");
  } finally { await rm(root, { recursive: true, force: true }); }
});

function createFixture(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE messages(
      id TEXT NOT NULL,topic TEXT NOT NULL,time INTEGER NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,
      priority INTEGER NOT NULL,tags TEXT NOT NULL,click TEXT NOT NULL,icon TEXT NOT NULL,PRIMARY KEY(topic,id)
    );
    INSERT INTO messages VALUES
      ('local-1','forwarded',101,'↗️ 转发｜Original','First',4,'["warning","outbox_tray"]','https://example.com/1',''),
      ('local-2','forwarded',102,'↗️ 转发','Second',3,'["outbox_tray"]','',''),
      ('other','deals',103,'Other','Other',3,'[]','','');
  `);
  db.close();
}
