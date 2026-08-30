import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LegacyReminderImportBundle } from "./reminder-repository";
import { ReminderRepository } from "./reminder-repository";

test("creates, completes, reopens, and expires reminders with explicit states", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-reminder-repo-"));
  try {
    const repository = new ReminderRepository(dataDir);
    const first = repository.create({
      title: " Prepare release ", deadline_local_date: "2026-09-02", importance: 3,
      now: "2026-08-30T00:00:00.000Z",
    });
    const expired = repository.create({
      title: "Past item", deadline_local_date: "2026-08-29", importance: 1,
      now: "2026-08-28T00:00:00.000Z",
    });
    expect(first).toMatchObject({ title: "Prepare release", status: "active", importance: 3 });
    expect(repository.complete(first.id, "2026-08-30T01:00:00.000Z"))
      .toMatchObject({ status: "completed", completed_at: "2026-08-30T01:00:00.000Z" });
    const reopened = repository.reopen(first.id, "2026-08-30T02:00:00.000Z");
    expect(reopened).toMatchObject({ status: "active" });
    expect(reopened.completed_at).toBeUndefined();
    expect(repository.expireBefore("2026-08-30", "2026-08-30T03:00:00.000Z")).toBe(1);
    expect(repository.get(expired.id)).toMatchObject({ status: "expired" });
    expect(repository.list("active").map((item) => item.id)).toEqual([first.id]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("keeps terminal delivery results immutable while allowing failed retries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-reminder-ledger-"));
  try {
    const repository = new ReminderRepository(dataDir);
    const reminder = repository.create({
      title: "Retry", deadline_local_date: "2026-08-30", importance: 5,
    });
    const base = {
      delivery_key: "reminder:item:test:2026-08-30:10",
      reminder_id: reminder.id,
      kind: "escalation" as const,
      local_date: "2026-08-30",
      slot: 10,
    };
    expect(repository.recordDelivery({ ...base, status: "failed", error: "temporary" }))
      .toMatchObject({ status: "failed", attempts: 1 });
    expect(repository.recordDelivery({ ...base, status: "completed", result: { accepted: true } }))
      .toMatchObject({ status: "completed", attempts: 2, result: { accepted: true } });
    expect(repository.recordDelivery({ ...base, status: "failed", error: "late failure" }))
      .toMatchObject({ status: "completed", attempts: 2 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("imports a logical legacy batch atomically, idempotently, and detects changed evidence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-reminder-import-"));
  try {
    const repository = new ReminderRepository(dataDir);
    const bundle = legacyBundle();
    expect(repository.importLegacy(bundle)).toEqual({ applied: true, items: 1, delivery_windows: 1 });
    expect(repository.importLegacy(bundle)).toEqual({ applied: false, items: 1, delivery_windows: 1 });
    expect(repository.list("active")).toHaveLength(1);
    expect(repository.getDelivery("reminder:item:legacy-memo-7:2026-08-30:10"))
      .toMatchObject({ status: "completed", attempts: 1 });
    expect(() => repository.importLegacy({ ...bundle, source_sha256: "b".repeat(64) }))
      .toThrow("changed after import");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function legacyBundle(): LegacyReminderImportBundle {
  return {
    source_ref: "notice-ntfy:memo:d75fa2d",
    source_sha256: "a".repeat(64),
    source_row_count: 2,
    items: [{
      id: "legacy-memo-7", title: "Legacy item", deadline_local_date: "2026-09-01",
      importance: 3, status: "active", legacy_ref: "notice-ntfy:memo:d75fa2d:item:7",
      created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T00:00:00.000Z",
    }],
    deliveries: [{
      delivery_key: "reminder:item:legacy-memo-7:2026-08-30:10",
      reminder_id: "legacy-memo-7", kind: "escalation", local_date: "2026-08-30",
      slot: 10, status: "completed", attempts: 1,
      legacy_ref: "notice-ntfy:memo:d75fa2d:item-delivery:7:2026-08-30:10",
      created_at: "2026-08-30T02:00:00.000Z", updated_at: "2026-08-30T02:00:00.000Z",
    }],
  };
}
