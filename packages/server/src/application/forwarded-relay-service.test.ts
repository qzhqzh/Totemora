import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NotificationDispatchResult } from "./notification-dispatcher";
import { ForwardedRelayService } from "./forwarded-relay-service";

const event = {
  source_id: "legacy-forwarded", source_message_id: "upstream-1", occurred_at: "2026-08-30T10:00:00Z",
  title: "Notice", body: "Body", priority: 4, tags: ["warning"], click_url: "https://example.com/story",
};
function result(status: NotificationDispatchResult["status"]): NotificationDispatchResult {
  return {
    envelope_id: "forwarded:relay:key", idempotency_key: "forwarded:relay:key", status,
    deliveries: status === "completed"
      ? [{ target_id: "legacy-forwarded", channel: "ntfy", status: "completed", evidence: "accepted" }]
      : [{ target_id: "legacy-forwarded", channel: "ntfy", status: status === "uncertain" ? "uncertain" : "failed" }],
  };
}

test("forwarded relay remains dormant without an explicit source secret", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-disabled-"));
  try {
    const service = new ForwardedRelayService({
      dataDir,
      source: { source_id: "legacy-forwarded", async configured() { return false; }, async collect() { throw new Error("no"); } },
      dispatcher: { async dispatch() { throw new Error("no"); } },
    });
    expect(await service.runDue()).toEqual({
      state: "disabled", fetched: 0, inserted: 0, deduped: 0,
      delivered: 0, failed: 0, uncertain: 0, pending_after_run: 0,
    });
    expect((await service.status()).configured).toBe(false);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("forwarded relay preserves metadata and dispatches an upstream id exactly once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-service-"));
  const envelopes: any[] = [];
  let sourceCalls = 0;
  try {
    const service = new ForwardedRelayService({
      dataDir,
      source: { source_id: "legacy-forwarded", async configured() { return true; }, async collect() { sourceCalls += 1; return [event]; } },
      dispatcher: { async dispatch(input) { envelopes.push(input.envelope); return result("completed"); } },
    });
    expect(await service.runDue(new Date("2026-08-30T10:05:00Z"))).toMatchObject({
      state: "completed", fetched: 1, inserted: 1, delivered: 1, failed: 0,
    });
    expect(await service.runDue(new Date("2026-08-30T10:06:00Z"))).toMatchObject({
      fetched: 1, inserted: 0, delivered: 0,
    });
    expect(sourceCalls).toBe(2);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      domain: "forwarded", kind: "relay", title: "↗️ 转发｜Notice", body: "Body", priority: 4,
      tags: ["warning", "outbox_tray"], source: { source_id: "upstream-1" },
    });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("forwarded relay retries known failures and blocks uncertain replay", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-retry-service-"));
  let dispatches = 0;
  try {
    const service = new ForwardedRelayService({
      dataDir,
      source: { source_id: "legacy-forwarded", async configured() { return true; }, async collect() { return [event]; } },
      dispatcher: { async dispatch() { dispatches += 1; return result(dispatches === 1 ? "failed" : "uncertain"); } },
    });
    expect((await service.runDue()).failed).toBe(1);
    expect((await service.runDue()).uncertain).toBe(1);
    expect((await service.runDue()).uncertain).toBe(0);
    expect(dispatches).toBe(2);
    expect((await service.status()).counts.uncertain).toBe(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
