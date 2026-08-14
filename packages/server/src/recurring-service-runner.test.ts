import { expect, test } from "bun:test";

import { RecurringServiceRunner } from "./recurring-service-runner";

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
