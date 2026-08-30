import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReminderRepository } from "../repositories/reminder-repository";
import { importLegacyMemoSnapshot } from "./legacy-memo-importer";

test("dry-runs then atomically imports only active memos and today's delivery ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-legacy-memo-"));
  const sourcePath = join(root, "memo-snapshot.db");
  const dataDir = join(root, "target");
  createFixture(sourcePath);
  try {
    const input = {
      sourcePath, sourceRef: "notice-ntfy:memo:test", localDate: "2026-08-30", dataDir,
    };
    await expect(importLegacyMemoSnapshot({ ...input, apply: false })).resolves.toMatchObject({
      active_items: 2, daily_delivery_windows: 1, item_delivery_windows: 2,
      apply_requested: false, applied: false,
    });
    expect(new ReminderRepository(dataDir).list("active")).toHaveLength(0);
    await expect(importLegacyMemoSnapshot({ ...input, apply: true })).resolves.toMatchObject({
      active_items: 2, daily_delivery_windows: 1, item_delivery_windows: 2,
      apply_requested: true, applied: true,
    });
    const repository = new ReminderRepository(dataDir);
    expect(repository.list("active")).toHaveLength(2);
    expect(repository.list("all")).toHaveLength(2);
    expect(repository.getDelivery("reminder:item:legacy-memo-1:2026-08-30:10"))
      .toMatchObject({ status: "completed", attempts: 1 });
    expect(repository.getDelivery("reminder:item:legacy-memo-2:2026-08-30:12"))
      .toMatchObject({ status: "uncertain", attempts: 2 });
    await expect(importLegacyMemoSnapshot({ ...input, apply: true })).resolves
      .toMatchObject({ applied: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a live WAL source and unsupported schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-legacy-memo-safety-"));
  const sourcePath = join(root, "memo.db");
  createFixture(sourcePath);
  try {
    await writeFile(`${sourcePath}-wal`, "active");
    await expect(importLegacyMemoSnapshot({
      sourcePath, sourceRef: "notice-ntfy:memo:test", localDate: "2026-08-30",
      dataDir: join(root, "target"), apply: false,
    })).rejects.toThrow("frozen SQLite backup");
    await rm(`${sourcePath}-wal`);

    const malformedPath = join(root, "malformed.db");
    const malformed = new Database(malformedPath, { create: true });
    malformed.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
    malformed.close();
    await expect(importLegacyMemoSnapshot({
      sourcePath: malformedPath, sourceRef: "notice-ntfy:memo:test", localDate: "2026-08-30",
      dataDir: join(root, "target"), apply: false,
    })).rejects.toThrow("unsupported items schema");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createFixture(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE items(
      id INTEGER PRIMARY KEY,title TEXT,deadline TEXT,status TEXT,created_at TEXT,
      completed_at TEXT,expired_at TEXT,importance INTEGER
    );
    CREATE TABLE deliveries(local_date TEXT PRIMARY KEY,delivered_at TEXT,item_count INTEGER);
    CREATE TABLE item_deliveries(
      item_id INTEGER,local_date TEXT,slot INTEGER,delivered_at TEXT,status TEXT,
      attempts INTEGER,updated_at TEXT,last_error TEXT,PRIMARY KEY(item_id,local_date,slot)
    );
    INSERT INTO items VALUES
      (1,'One','2026-09-01','active','2026-08-01T08:00:00+08:00',NULL,NULL,3),
      (2,'Two','2026-08-30','active','2026-08-02T08:00:00+08:00',NULL,NULL,5),
      (3,'Old','2026-08-20','expired','2026-08-03T08:00:00+08:00',NULL,'2026-08-21',1);
    INSERT INTO deliveries VALUES('2026-08-30','2026-08-30T10:00:00+08:00',1);
    INSERT INTO item_deliveries VALUES
      (1,'2026-08-30',10,'2026-08-30T10:00:00+08:00','sent',1,'2026-08-30T10:00:00+08:00',NULL),
      (2,'2026-08-30',12,'2026-08-30T12:00:00+08:00','publishing',2,'2026-08-30T12:01:00+08:00','unknown'),
      (3,'2026-08-30',10,'2026-08-30T10:00:00+08:00','sent',1,'2026-08-30T10:00:00+08:00',NULL),
      (1,'2026-08-29',10,'2026-08-29T10:00:00+08:00','sent',1,'2026-08-29T10:00:00+08:00',NULL);
  `);
  db.close();
}
