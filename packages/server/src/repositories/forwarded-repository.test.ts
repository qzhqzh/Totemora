import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ForwardedRepository } from "./forwarded-repository";

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
