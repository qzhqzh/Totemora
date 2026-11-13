import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ForwardedRepository } from "./forwarded-repository";
import { StateDatabase } from "../state-database";

const event = {
  source_id: "legacy-forwarded", source_message_id: "upstream-1", occurred_at: "2026-08-30T10:00:00Z",
  title: "Notice", body: "Body", priority: 4, tags: ["warning"],
};

test("forwarded repository imports history and deduplicates an overlapping upstream event by content", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-import-"));
  try {
    const repository = new ForwardedRepository(dataDir);
    const bundle = {
      source_ref: "notice-ntfy:forwarded:test", source_sha256: "a".repeat(64), source_row_count: 1,
      cursor_time: 1788084000,
      events: [{ ...event, source_message_id: "local-copy", legacy_ref: "notice-ntfy:forwarded:item:local-copy" }],
    };
    expect(repository.importLegacy(bundle)).toEqual({ applied: true, events: 1, inserted_events: 1 });
    expect(repository.importLegacy(bundle)).toEqual({ applied: false, events: 1, inserted_events: 0 });
    expect(() => repository.importLegacy({ ...bundle, source_sha256: "b".repeat(64) })).toThrow("changed after import");
    const ingested = repository.ingestPoll({ source_id: "legacy-forwarded", events: [event], cursor_time: 1788084000 });
    expect(ingested).toMatchObject({ inserted: 1, pending: 0, deduped: 1 });
    expect(repository.summary("legacy-forwarded").counts).toMatchObject({ completed: 1, deduped: 1, pending: 0 });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a pre-existing failed source receives backoff without rewriting its cursor or history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-existing-failure-"));
  try {
    const repository = new ForwardedRepository(dataDir);
    StateDatabase.open(dataDir).db.query(`
      INSERT INTO forwarded_source_state(source_id,cursor_time,last_error,last_added,updated_at)
      VALUES('legacy-forwarded',1788084000,'unknown certificate verification error',0,'2026-08-30T10:00:00.000Z')
    `).run();
    expect(repository.summary("legacy-forwarded")).toMatchObject({
      source: { cursor_time: 1788084000, last_error: "unknown certificate verification error" },
      polling: { consecutive_failures: 1, failure_kind: "certificate", next_poll_at: "2026-08-30T10:30:00.000Z" },
    });
    repository.recordPollFailure("legacy-forwarded", "certificate verification failed", "2026-08-30T10:30:00Z", "certificate");
    expect(new ForwardedRepository(dataDir).pollingBackoff("legacy-forwarded")).toMatchObject({
      consecutive_failures: 2, next_poll_at: "2026-08-30T11:30:00.000Z",
    });
    expect(repository.sourceState("legacy-forwarded")?.cursor_time).toBe(1788084000);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("successful ingestion clears backoff atomically while invalid ingestion preserves it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-backoff-transaction-"));
  try {
    const repository = new ForwardedRepository(dataDir);
    repository.recordPollFailure("legacy-forwarded", "offline", "2026-08-30T10:00:00Z");
    expect(() => repository.ingestPoll({
      source_id: "legacy-forwarded", events: [event, { ...event, source_message_id: "invalid", priority: 6 }], cursor_time: 0,
    })).toThrow();
    expect(repository.pending()).toHaveLength(0);
    expect(repository.pollingBackoff("legacy-forwarded")?.consecutive_failures).toBe(1);
    repository.ingestPoll({ source_id: "legacy-forwarded", events: [event], cursor_time: 0 });
    expect(repository.pollingBackoff("legacy-forwarded")).toBeUndefined();
    expect(repository.sourceState("legacy-forwarded")?.last_error).toBeUndefined();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("delivery backoff does not block fresh queued messages behind failed ones", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-delivery-backoff-"));
  try {
    const repository = new ForwardedRepository(dataDir);
    repository.ingestPoll({
      source_id: "legacy-forwarded", cursor_time: 0,
      events: Array.from({ length: 21 }, (_, i) => ({ ...event, source_message_id: `old-${i}` })),
    });
    for (const item of repository.pending(100)) {
      repository.recordDelivery({ id: item.id, status: "failed", now: "2026-08-30T10:00:00Z" });
    }
    repository.ingestPoll({ source_id: "legacy-forwarded", cursor_time: 0,
      events: [{ ...event, source_message_id: "fresh", occurred_at: "2026-08-30T10:01:00Z" }],
    });
    expect(repository.pending(20, "2026-08-30T10:01:00Z").map((item) => item.source_message_id)).toEqual(["fresh"]);
    expect(repository.pending(100, "2026-08-30T10:05:00Z")).toHaveLength(22);
    const failed = repository.pending(100).find((item) => item.source_message_id === "old-0")!;
    repository.recordDelivery({ id: failed.id, status: "failed", now: "2026-08-30T10:05:00Z" });
    expect(repository.pending(100, "2026-08-30T10:14:59Z").find((item) => item.id === failed.id)).toBeUndefined();
    expect(repository.pending(100, "2026-08-30T10:15:00Z").find((item) => item.id === failed.id)).toBeDefined();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("forwarded repository retries known failures and terminalizes uncertain delivery", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-retry-"));
  try {
    const repository = new ForwardedRepository(dataDir);
    repository.ingestPoll({ source_id: "legacy-forwarded", events: [event], cursor_time: 1788084000 });
    const pending = repository.pending()[0]!;
    expect(repository.recordDelivery({ id: pending.id, status: "failed", error: "offline" }))
      .toMatchObject({ status: "failed", attempts: 1 });
    expect(repository.pending()).toHaveLength(1);
    expect(repository.recordDelivery({ id: pending.id, status: "uncertain", result: { status: "uncertain" } }))
      .toMatchObject({ status: "uncertain", attempts: 2 });
    expect(repository.pending()).toHaveLength(0);
    repository.recordPollFailure("legacy-forwarded", "upstream unavailable", "2026-08-30T10:05:00Z");
    expect(repository.sourceState("legacy-forwarded")).toMatchObject({ last_error: "upstream unavailable" });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
