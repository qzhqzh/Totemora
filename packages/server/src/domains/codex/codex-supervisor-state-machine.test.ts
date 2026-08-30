import { expect, test } from "bun:test";

import { evaluateCodexThread } from "./codex-supervisor-state-machine";
import type { CodexInteraction, CodexThreadRecord } from "./codex-supervisor-types";

test("state machine never runs observed, expired, budget-limited, or interrupted threads", () => {
  expect(evaluateCodexThread(thread({ mode: "observed", phase: "observed" }), [])).toMatchObject({ action: "none" });
  expect(evaluateCodexThread(thread({ deadline_at: "2020-01-01" }), [])).toMatchObject({ action: "pause", phase: "paused" });
  expect(evaluateCodexThread(thread({ token_used: 10, token_budget: 10 }), [])).toMatchObject({ action: "pause" });
  expect(evaluateCodexThread(thread({ last_turn_status: "interrupted" }), [])).toMatchObject({ action: "pause" });
});

test("state machine waits for human interactions and active turns", () => {
  expect(evaluateCodexThread(thread(), [interaction("approval")])).toMatchObject({
    action: "wait_approval", phase: "waiting_approval",
  });
  expect(evaluateCodexThread(thread(), [interaction("decision")])).toMatchObject({
    action: "wait_decision", phase: "waiting_decision",
  });
  expect(evaluateCodexThread(thread({ app_status: "active" }), [])).toMatchObject({ action: "wait_active" });
});

test("state machine aligns, continues, retries, verifies, and completes through explicit gates", () => {
  expect(evaluateCodexThread(thread({ phase: "aligning" }), [])).toMatchObject({ action: "align" });
  expect(evaluateCodexThread(thread({ app_status: "idle" }), [])).toMatchObject({ action: "continue" });
  expect(evaluateCodexThread(thread({ app_status: "systemError", infra_retries: 2 }), [])).toMatchObject({
    action: "retry_infrastructure", phase: "retry_wait",
  });
  expect(evaluateCodexThread(thread({ app_status: "systemError", infra_retries: 3 }), [])).toMatchObject({ action: "fail" });
  expect(evaluateCodexThread(thread({ goal_status: "complete" }), [])).toMatchObject({ action: "verify" });
  expect(evaluateCodexThread(thread({ goal_status: "complete", phase: "verifying", last_turn_status: "completed" }), []))
    .toMatchObject({ action: "complete", phase: "completed" });
});

test("state machine re-aligns after infrastructure backoff and pauses paginated history", () => {
  expect(evaluateCodexThread(thread({
    phase: "retry_wait",
    next_action_at: "2026-08-29T23:59:00.000Z",
  }), [], new Date("2026-08-30T00:00:00.000Z"))).toMatchObject({ action: "align", phase: "aligning" });
  expect(evaluateCodexThread(thread({ history_mode: "paginated" }), [])).toMatchObject({
    action: "pause",
    phase: "paused",
  });
});

test("state machine limits agent alternative strategies", () => {
  expect(evaluateCodexThread(thread({ last_turn_status: "failed", strategy_attempts: 4 }), []))
    .toMatchObject({ action: "continue_alternative" });
  expect(evaluateCodexThread(thread({ last_turn_status: "failed", strategy_attempts: 5 }), []))
    .toMatchObject({ action: "fail" });
});

function thread(patch: Partial<CodexThreadRecord> = {}): CodexThreadRecord {
  return {
    thread_id: "thread-1", cwd: "/work", workplace_id: "workplace-1", preview: "",
    source: {}, app_status: "idle", app_updated_at: 1, mode: "managed", phase: "executing",
    goal_objective: "finish", goal_status: "active", token_budget: 150_000, token_used: 1,
    infra_retries: 0, strategy_attempts: 0, last_observed_at: "2026-08-01", revision: 1,
    created_at: "2026-08-01", updated_at: "2026-08-01", ...patch,
  };
}

function interaction(kind: "approval" | "decision"): CodexInteraction {
  return {
    id: `${kind}-1`, thread_id: "thread-1", kind, status: "open", title: kind, body: kind,
    options: [], source: "agent", revision: 1, created_at: "2026-08-01", updated_at: "2026-08-01",
  };
}
