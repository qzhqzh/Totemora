import { expect, test } from "bun:test";
import type { RecurringServiceState } from "../recurring-service-runner";
import type { DealSourceHealth } from "../repositories/deal-repository";
import { recurringServiceHealth } from "./recurring-service-health";

type HealthInput = Parameters<typeof recurringServiceHealth>[0];
type ForwardedStatus = Awaited<ReturnType<HealthInput["forwarded"]["status"]>>;
const timestamp = "2026-10-25T10:00:00.000Z";
const nextPoll = "2026-10-25T10:30:00.000Z";
const source = { source_id: "legacy-forwarded", cursor_time: 1788084000, last_added: 0, updated_at: timestamp };
const polling: NonNullable<ForwardedStatus["polling"]> = {
  consecutive_failures: 3, failure_kind: "tls", last_failure_at: timestamp, next_poll_at: nextPoll,
};
function state(id: string): RecurringServiceState {
  return { id, running: false, runs: 10, skipped_overlaps: 2, failures: 3, last_finished_at: timestamp };
}
function inputs(states: RecurringServiceState[], forwarded: Partial<ForwardedStatus> = {}, health?: DealSourceHealth): HealthInput {
  return {
    states,
    deals: { status: () => ({ counts: { pending: 0, delivered: 0, uncertain: 0, skipped: 0 }, source_health: health }) },
    forwarded: { status: async () => ({
      configured: true, counts: { pending: 0, completed: 0, failed: 0, uncertain: 0, deduped: 0 }, ...forwarded,
    }) },
  };
}

test("deal blocked and backoff health retain their upstream errors and retry timestamps", async () => {
  for (const status of ["blocked", "backoff"] as const) {
    const scheduler = { ...state("deals.watch"), last_error: "previous scheduler failure" };
    const health = { status, error: "source access is blocked", retry_after: nextPoll };
    expect(await recurringServiceHealth(inputs([scheduler], {}, health))).toEqual([{ ...scheduler, source_health: health }]);
    expect(scheduler).not.toHaveProperty("source_health");
  }
});

test("forwarded maps disabled, backoff, blocked, ready and not-started source states", async () => {
  const scheduler = state("forwarded.relay");
  const cases: Array<{ forwarded: Partial<ForwardedStatus>; expected: {
    status: string; error?: string; retry_after?: string;
    failure_kind?: NonNullable<ForwardedStatus["polling"]>["failure_kind"];
  } }> = [
    { forwarded: { configured: false }, expected: { status: "disabled" } },
    { forwarded: { source: { ...source, last_error: "TLS handshake failed" }, polling }, expected: {
      status: "backoff", retry_after: nextPoll, failure_kind: "tls", error: "TLS handshake failed",
    } },
    { forwarded: { source: { ...source, last_success_at: timestamp, last_error: "source remains unavailable" } }, expected: {
      status: "blocked", error: "source remains unavailable",
    } },
    { forwarded: { source: { ...source, last_success_at: timestamp } }, expected: { status: "ready" } },
    { forwarded: {}, expected: { status: "not_started" } },
    { forwarded: { source }, expected: { status: "not_started" } },
  ];
  for (const item of cases) {
    expect(await recurringServiceHealth(inputs([scheduler], item.forwarded))).toEqual([{ ...scheduler, source_health: item.expected }]);
  }
});

test("disabled forwarded configuration preserves the recorded failure and next poll evidence", async () => {
  const scheduler = state("forwarded.relay");
  const forwarded = { configured: false, source: { ...source, last_error: "credentials are unreadable" },
    polling: { ...polling, failure_kind: "configuration" as const } };
  expect(await recurringServiceHealth(inputs([scheduler], forwarded))).toEqual([{
    ...scheduler, source_health: { status: "disabled", retry_after: nextPoll,
      failure_kind: "configuration", error: "credentials are unreadable" },
  }]);
});

test("successful scheduler skips do not make unresolved upstream failures healthy", async () => {
  const scheduler = state("forwarded.relay");
  const pastPoll = "2026-10-24T10:00:00.000Z";
  expect(await recurringServiceHealth(inputs([scheduler], {
    source: { ...source, last_success_at: "2026-10-23T10:00:00.000Z", last_error: "certificate verification failed" },
    polling: { ...polling, failure_kind: "certificate", next_poll_at: pastPoll },
  }))).toEqual([{
    ...scheduler, source_health: { status: "backoff", error: "certificate verification failed", failure_kind: "certificate", retry_after: pastPoll },
  }]);
  expect(scheduler.last_error).toBeUndefined();
});

test("health enrichment preserves scheduler counters, unrelated services and input objects", async () => {
  const states = [state("deals.watch"), state("forwarded.relay"), { ...state("content.studio"), running: true }];
  const before = structuredClone(states);
  const result = await recurringServiceHealth(inputs(states, { source: { ...source, last_success_at: timestamp } }, { status: "ready" }));
  expect(result).toEqual([
    { ...states[0], source_health: { status: "ready" } },
    { ...states[1], source_health: { status: "ready" } },
    states[2],
  ]);
  expect(result[2]).toBe(states[2]);
  expect(states).toEqual(before);
});
