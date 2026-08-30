import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NotificationDispatchResult } from "./notification-dispatcher";
import { DealsService } from "./deals-service";

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
    const service = new DealsService({
      dataDir,
      source: { async collect() { sourceCalls += 1; return collected; } },
      dispatcher: { async dispatch() {
        dispatchCalls += 1;
        return result(dispatchCalls === 1 ? "failed" : "uncertain");
      } },
    });
    expect((await service.runDue(new Date("2026-08-30T10:05:00Z"))).delivery_status).toBe("failed");
    expect(await service.runDue(new Date("2026-08-30T10:06:00Z"))).toMatchObject({
      delivery_status: "uncertain", retried_window: true, source_fetched: 0,
    });
    expect((await service.runDue(new Date("2026-08-30T10:07:00Z"))).delivery_status).toBe("skipped_existing");
    expect(sourceCalls).toBe(1);
    expect(dispatchCalls).toBe(2);
    expect(service.status().counts.uncertain).toBe(1);
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
