import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NotificationDispatchResult } from "./notification-dispatcher";
import { DealsService } from "./deals-service";
import { DealSourceAccessBlockedError } from "../domains/deals/deal-retry";

const collected = [{
  source_id: "123", title: "测试商品", deal_text: "9.9 元包邮", merchant: "京东商城",
  source_url: "https://example.com/123", source_rank: 1,
}];

function result(status: NotificationDispatchResult["status"]): NotificationDispatchResult {
  return {
    envelope_id: "deals:digest:2026-08-30:18",
    idempotency_key: "deals:digest:2026-08-30:18",
    status,
    deliveries: status === "completed"
      ? [{ target_id: "legacy-deals", channel: "ntfy", status: "completed", evidence: "accepted" }]
      : [{ target_id: "legacy-deals", channel: "ntfy", status: status === "uncertain" ? "uncertain" : "failed" }],
  };
}

test("deals service collects and dispatches one stable hourly digest", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-deals-service-"));
  let sourceCalls = 0;
  const envelopes: unknown[] = [];
  try {
    const service = new DealsService({
      dataDir,
      source: { async collect() { sourceCalls += 1; return collected; } },
      dispatcher: { async dispatch(input) { envelopes.push(input.envelope); return result("completed"); } },
    });
    expect(await service.runDue(new Date("2026-08-30T10:05:00Z"))).toMatchObject({
      local_hour: "2026-08-30T18", source_fetched: 1, inserted_items: 1,
      selected_items: 1, delivery_status: "completed", retried_window: false,
    });
    expect(await service.runDue(new Date("2026-08-30T10:30:00Z"))).toMatchObject({
      delivery_status: "skipped_existing",
    });
    expect(sourceCalls).toBe(1);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ domain: "deals", kind: "digest", priority: 3 });
    expect(service.status().counts.delivered).toBe(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("deals service retries definite failures and never replays uncertain windows", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-deals-retry-service-"));
  let sourceCalls = 0;
  let dispatchCalls = 0;
  try {
    const input = {
      dataDir,
      source: { async collect() { sourceCalls += 1; return collected; } },
      dispatcher: { async dispatch() {
        dispatchCalls += 1;
        return result(dispatchCalls === 1 ? "failed" : "uncertain");
      } },
    };
    const service = new DealsService(input);
    expect((await service.runDue(new Date("2026-08-30T10:05:00Z"))).delivery_status).toBe("failed");
    const restarted = new DealsService(input);
    expect(await restarted.runDue(new Date("2026-08-30T10:09:59.999Z"))).toMatchObject({
      delivery_status: "skipped_backoff", retried_window: true,
      retry_after: "2026-08-30T10:10:00.000Z",
    });
    expect(await restarted.runDue(new Date("2026-08-30T10:10:00Z"))).toMatchObject({
      delivery_status: "uncertain", retried_window: true, source_fetched: 0,
    });
    expect((await service.runDue(new Date("2026-08-30T10:11:00Z"))).delivery_status).toBe("skipped_existing");
    expect(sourceCalls).toBe(1);
    expect(dispatchCalls).toBe(2);
    expect(service.status().counts.uncertain).toBe(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("deals source failures back off across service restart and preserve the failing source evidence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-deals-source-cooldown-"));
  let sourceCalls = 0;
  let dispatchCalls = 0;
  const clock = new Date();
  const input = {
    dataDir,
    source: { async collect() {
      sourceCalls += 1;
      if (sourceCalls < 2) throw new DealSourceAccessBlockedError("source access requires review");
      return collected;
    } },
    dispatcher: { async dispatch() { dispatchCalls += 1; return result("completed"); } },
  };
  try {
    const service = new DealsService(input);
    await expect(service.runDue(clock)).rejects.toThrow("source access requires review");
    const failure = service.status().latest_source_run;
    const restarted = new DealsService(input);
    expect(await restarted.runDue(new Date(clock.getTime() + 60_000))).toMatchObject({
      delivery_status: "skipped_backoff", source_fetched: 0,
      retry_after: new Date(Date.parse(failure!.finished_at) + 300_000).toISOString(),
      error: "Deals source access blocked: source access requires review",
    });
    expect(sourceCalls).toBe(1);
    expect(dispatchCalls).toBe(0);
    expect(restarted.status().latest_source_run).toEqual(failure);
    expect(restarted.status().source_health?.status).toBe("blocked");
    const retryAt = new Date(restarted.status().source_health!.retry_after!);
    expect((await restarted.runDue(new Date(retryAt.getTime() - 1))).delivery_status).toBe("skipped_backoff");
    expect((await restarted.runDue(retryAt)).delivery_status).toBe("completed");
    expect(sourceCalls).toBe(2);
    expect(dispatchCalls).toBe(1);
    expect(restarted.status().source_health?.status).toBe("ready");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("deals service records source failures and lets recurring supervision see the failure", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-deals-source-failure-"));
  try {
    const service = new DealsService({
      dataDir,
      source: { async collect() { throw new Error("source unavailable"); } },
      dispatcher: { async dispatch() { return result("completed"); } },
    });
    await expect(service.runDue(new Date("2026-08-30T10:05:00Z"))).rejects.toThrow("source unavailable");
    expect(service.status().latest_source_run).toMatchObject({ status: "error", error: "source unavailable" });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
