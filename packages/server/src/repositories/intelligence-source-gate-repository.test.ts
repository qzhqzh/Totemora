import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../state-database";
import { IntelligenceSourceGateRepository } from "./intelligence-source-gate-repository";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "intelligence-source-gate-")); directories.push(dataDir);
  return { repository: new IntelligenceSourceGateRepository(dataDir), state: StateDatabase.open(dataDir) };
}
const empty = { scans: 0, collected: 0, out_of_scope: 0, history_suppressed: 0, model_evaluated: 0, avoided: 0 };

test("empty domains return zero totals without nullable aggregates", async () => {
  const { repository } = await fixture();
  expect(repository.aggregate("ai")).toEqual(empty);
  expect(repository.aggregate("finance")).toEqual(empty);
});

test("mixed legacy gates preserve totals, numeric-zero avoidance and domain isolation", async () => {
  const { repository, state } = await fixture();
  const ai = [
    {}, { source_gate: null }, { source_gate: {} },
    { source_gate: { collected: 8, out_of_scope: 2, history_suppressed: 3, model_evaluated: 3 } },
    { source_gate: { collected: 4, history_suppressed: 4, model_evaluated: 0 } },
    { source_gate: { history_suppressed: 5 } },
    { source_gate: { history_suppressed: 6, model_evaluated: null } },
    { source_gate: { history_suppressed: 7, model_evaluated: "0" } },
    { source_gate: { history_suppressed: 8, model_evaluated: false } },
    { source_gate: { history_suppressed: 0, model_evaluated: 0 } },
    { source_gate: { model_evaluated: 0 } },
  ];
  ai.forEach((value, index) => state.putRecord("intelligence_briefs", `scan-${index}`, value));
  state.putRecord("finance_intelligence_briefs", "finance", {
    source_gate: { collected: 12, out_of_scope: 4, history_suppressed: 2, model_evaluated: 6, capacity_suppressed: 100 },
  });
  state.putRecord("finance_intelligence_briefs", "legacy", {});
  state.putRecord("another_namespace", "ignored", { source_gate: { collected: 999, history_suppressed: 999, model_evaluated: 0 } });
  expect(repository.aggregate("ai")).toEqual({ scans: ai.length, collected: 12, out_of_scope: 2,
    history_suppressed: 33, model_evaluated: 3, avoided: 1 });
  expect(repository.aggregate("finance")).toEqual({ scans: 2, collected: 12, out_of_scope: 4,
    history_suppressed: 2, model_evaluated: 6, avoided: 0 });
});

test("aggregation includes all historical scans instead of a recent-page or retention cutoff", async () => {
  const { repository, state } = await fixture();
  state.db.transaction(() => {
    for (let index = 0; index < 205; index++) {
      state.putRecord("intelligence_briefs", `historical-${index}`, {
        source_gate: { collected: 5, out_of_scope: 1, history_suppressed: 4, model_evaluated: 0 },
      }, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    }
  })();
  expect(repository.aggregate("ai")).toEqual({ scans: 205, collected: 1025, out_of_scope: 205,
    history_suppressed: 820, model_evaluated: 0, avoided: 205 });
  expect(repository.aggregate("finance")).toEqual(empty);
});
