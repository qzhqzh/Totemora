import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NotificationDispatchResult } from "./notification-dispatcher";
import { ForwardedRelayService } from "./forwarded-relay-service";
import { ForwardedRepository } from "../repositories/forwarded-repository";

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
    expect((await service.runDue(new Date("2026-08-30T10:05:00Z"))).failed).toBe(1);
    expect((await service.runDue(new Date("2026-08-30T10:06:00Z"))).uncertain).toBe(0);
    expect((await service.runDue(new Date("2026-08-30T10:10:00Z"))).uncertain).toBe(1);
    expect((await service.runDue(new Date("2026-08-30T10:15:00Z"))).uncertain).toBe(0);
    expect(dispatches).toBe(2);
    expect((await service.status()).counts.uncertain).toBe(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("forwarded source failures persist backoff across service restarts and recover without replay", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-backoff-"));
  let calls = 0;
  let recovered = false;
  const input = {
    dataDir,
    source: {
      source_id: "legacy-forwarded", async configured() { return true; },
      async collect() { calls += 1; if (!recovered) throw new Error("unknown certificate verification error"); return [event]; },
    },
    dispatcher: { async dispatch() { return result("completed"); } },
  };
  try {
    const service = new ForwardedRelayService(input);
    await expect(service.runDue(new Date("2026-08-30T10:00:00Z"))).rejects.toThrow("certificate");
    const restarted = new ForwardedRelayService(input);
    expect(await restarted.runDue(new Date("2026-08-30T10:01:00Z"))).toMatchObject({ state: "backoff" });
    expect(calls).toBe(1);
    expect(await restarted.status()).toMatchObject({
      polling: { consecutive_failures: 1, failure_kind: "certificate", next_poll_at: "2026-08-30T10:30:00.000Z" },
    });
    await expect(restarted.runDue(new Date("2026-08-30T10:30:00Z"))).rejects.toThrow("certificate");
    expect(await restarted.status()).toMatchObject({ polling: { consecutive_failures: 2, next_poll_at: "2026-08-30T11:30:00.000Z" } });
    recovered = true;
    expect(await restarted.runDue(new Date("2026-08-30T11:30:00Z"))).toMatchObject({ state: "completed", delivered: 1 });
    expect((await restarted.status()).polling).toBeUndefined();
    expect((await restarted.status()).source?.last_error).toBeUndefined();
    expect(await restarted.runDue(new Date("2026-08-30T11:31:00Z"))).toMatchObject({ delivered: 0 });
    expect(calls).toBe(4);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a source outage still drains durable pending deliveries and does not advance the cursor", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-drain-"));
  try {
    const repository = new ForwardedRepository(dataDir);
    repository.ingestPoll({ source_id: "legacy-forwarded", events: [event], cursor_time: 1788084000 });
    let delivered = 0;
    const service = new ForwardedRelayService({
      dataDir,
      source: { source_id: "legacy-forwarded", async configured() { return true; }, async collect() { throw new Error("offline"); } },
      dispatcher: { async dispatch() { delivered += 1; return result("completed"); } },
    });
    await expect(service.runDue(new Date("2026-08-30T10:05:00Z"))).rejects.toThrow();
    expect(delivered).toBe(1);
    expect(repository.sourceState("legacy-forwarded")?.cursor_time).toBe(1788084000);
    expect(await service.runDue(new Date("2026-08-30T10:06:00Z"))).toMatchObject({ state: "backoff", delivered: 0 });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("invalid source configuration backs off and remains inspectable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-config-"));
  let configuredCalls = 0;
  try {
    const service = new ForwardedRelayService({
      dataDir,
      source: {
        source_id: "legacy-forwarded",
        async configured() { configuredCalls += 1; throw new Error("Forwarded source credentials must use owner-only permissions"); },
        async collect() { throw new Error("must not poll"); },
      },
      dispatcher: { async dispatch() { throw new Error("must not send"); } },
    });
    await expect(service.runDue(new Date("2026-08-30T10:00:00Z"))).rejects.toThrow();
    expect(await service.runDue(new Date("2026-08-30T10:01:00Z"))).toMatchObject({ state: "backoff" });
    expect(configuredCalls).toBe(1);
    expect(await service.status()).toMatchObject({ configured: false, polling: { failure_kind: "configuration" } });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a thrown dispatcher response is uncertain and is never automatically replayed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-forwarded-unknown-"));
  let dispatches = 0;
  try {
    const service = new ForwardedRelayService({
      dataDir,
      source: { source_id: "legacy-forwarded", async configured() { return true; }, async collect() { return [event]; } },
      dispatcher: { async dispatch() { dispatches += 1; throw new Error("response lost after acceptance"); } },
    });
    expect(await service.runDue(new Date("2026-08-30T10:00:00Z"))).toMatchObject({ uncertain: 1, failed: 0 });
    expect(await service.runDue(new Date("2026-08-30T11:00:00Z"))).toMatchObject({ uncertain: 0, delivered: 0 });
    expect(dispatches).toBe(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
