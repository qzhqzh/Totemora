import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RecurringServiceRunner } from "./recurring-service-runner";
import { RecurringServiceStateRepository } from "./recurring-service-state-repository";

test("recurring service runner prevents overlap and isolates failures", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const runner = new RecurringServiceRunner([{
    id: "intelligence.watch", interval_ms: 60_000,
    async run() {
      calls += 1;
      if (calls === 1) await blocked;
      else throw new Error("source unavailable");
    },
  }]);

  const first = runner.tick("intelligence.watch");
  expect(await runner.tick("intelligence.watch")).toBe("skipped_overlap");
  release();
  expect(await first).toBe("completed");
  expect(await runner.tick("intelligence.watch")).toBe("failed");
  expect(runner.status()).toEqual([expect.objectContaining({
    id: "intelligence.watch", running: false, runs: 2,
    skipped_overlaps: 1, failures: 1, last_error: "source unavailable",
  })]);
});

test("recurring service runner restores durable counters after restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-recurring-state-"));
  try {
    const first = new RecurringServiceRunner([{
      id: "finance.watch", interval_ms: 60_000, async run() {},
    }], new RecurringServiceStateRepository(dataDir));
    expect(await first.tick("finance.watch")).toBe("completed");

    const restored = new RecurringServiceRunner([{
      id: "finance.watch", interval_ms: 60_000, async run() {},
    }], new RecurringServiceStateRepository(dataDir));
    expect(restored.status()).toEqual([expect.objectContaining({
      id: "finance.watch", running: false, runs: 1, failures: 0,
      last_started_at: expect.any(String), last_finished_at: expect.any(String),
    })]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("recurring service runner records a restart-interrupted tick as failed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-recurring-interrupted-"));
  try {
    const repository = new RecurringServiceStateRepository(dataDir);
    repository.save({
      id: "content.studio", running: true, runs: 3,
      skipped_overlaps: 1, failures: 0, last_started_at: "2026-08-26T00:00:00.000Z",
    });
    const restored = new RecurringServiceRunner([{
      id: "content.studio", interval_ms: 60_000, async run() {},
    }], repository);
    expect(restored.status()).toEqual([expect.objectContaining({
      id: "content.studio", running: false, runs: 3, skipped_overlaps: 1, failures: 1,
      last_error: "Gateway restarted while the recurring service was running",
    })]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
