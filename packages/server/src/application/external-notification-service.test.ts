import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NotificationIngressConfig } from "../bootstrap/notification-ingress-config";
import type { NotificationDispatchResult } from "./notification-dispatcher";
import { ExternalNotificationService } from "./external-notification-service";
import { handleExternalNotificationRoutes } from "../http/external-notification-routes";
import { HttpError } from "../http/http-boundary";
import { ExternalNotificationRepository } from "../repositories/external-notification-repository";
import { NotifierDatabase } from "../../../notifier/src/storage";

const token = "a".repeat(64);
const config: NotificationIngressConfig = {
  sources: [{ id: "backup", token }],
  rules: [{ id: "failures", source: "backup", type_prefix: "backup.failed",
    targets: ["email:owner"], coalesce_window_seconds: 300 }],
  email: [{ id: "owner", address: "owner@example.test", enabled: true }],
};
const event = { schema_version: 1, source: "backup", id: "run-42", type: "backup.failed",
  title: "Backup failed", body: "Storage not reachable", priority: 4, dedupe_key: "storage" };
const target = { id: "owner", channel: "email" as const, domains: ["ops" as const], enabled: true };

function receipt(status: NotificationDispatchResult["status"]): NotificationDispatchResult {
  return { envelope_id: "external:uuid", idempotency_key: "external:digest", status,
    deliveries: [{ target_id: "owner", channel: "email", status: status === "uncertain" ? "uncertain"
      : status === "completed" ? "completed" : "failed" }] };
}

test("ingress authenticates, durably acknowledges before sending, deduplicates and preserves unrouted events", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ingress-service-"));
  const sent: unknown[] = [];
  try {
    const service = new ExternalNotificationService(dataDir, config,
      { async dispatch(input) { sent.push(input); return receipt("completed"); } },
      async () => [target]);
    await expect(service.accept(event, null)).rejects.toThrow("Unknown notification source or credential");
    await expect(service.accept({ ...event, source: "stranger" }, `Bearer ${token}`))
      .rejects.toThrow("Unknown notification source or credential");
    await expect(service.accept(event, "Bearer wrong")).rejects.toThrow("Unknown notification source or credential");
    const accepted = await service.accept(event, `Bearer ${token}`);
    expect(accepted).toMatchObject({ source: "backup", id: "run-42", status: "pending", duplicate: false });
    expect(sent).toHaveLength(0);
    const restarted = new ExternalNotificationService(dataDir, config,
      { async dispatch(input) { sent.push(input); return receipt("completed"); } },
      async () => [target]);
    expect(await restarted.runDue()).toMatchObject({ claimed: 1, completed: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ allowed_targets: ["email:owner"], envelope: { domain: "ops" } });
    expect(await service.accept(event, `Bearer ${token}`))
      .toMatchObject({ event_uuid: accepted.event_uuid, status: "completed", duplicate: true });
    const unavailableTargets = new ExternalNotificationService(dataDir, config,
      { async dispatch() { throw new Error("must not send"); } },
      async () => { throw new Error("target catalog offline"); });
    expect(await unavailableTargets.accept(event, `Bearer ${token}`))
      .toMatchObject({ event_uuid: accepted.event_uuid, status: "completed", duplicate: true });
    await expect(service.accept({ ...event, title: "Changed" }, `Bearer ${token}`))
      .rejects.toThrow("source + id was already used");
    const unknown = await service.accept({ ...event, id: "run-43", type: "backup.completed" }, `Bearer ${token}`);
    expect(unknown.status).toBe("unrouted");
    expect(service.list("unrouted", 10)).toMatchObject([{ event_uuid: unknown.event_uuid, last_error: "No routing rule matched" }]);
    expect(JSON.stringify(service.list("all", 10))).not.toContain(token);
    expect(await restarted.runDue()).toMatchObject({ claimed: 0 });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("coalescing requires a caller key; missing target is retained as unrouted", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ingress-coalesce-"));
  try {
    const service = new ExternalNotificationService(dataDir, config,
      { async dispatch() { throw new Error("must not send yet"); } }, async () => [target]);
    const first = await service.accept(event, `Bearer ${token}`);
    const repeated = await service.accept({ ...event, id: "run-43" }, `Bearer ${token}`);
    expect(repeated.status).toBe("coalesced");
    expect(service.list("coalesced", 10)[0]?.coalesced_by).toBe(first.event_uuid);
    const withoutKey = await service.accept({ ...event, id: "run-44", dedupe_key: undefined }, `Bearer ${token}`);
    expect(withoutKey.status).toBe("pending");
    const unavailable = new ExternalNotificationService(dataDir, config,
      { async dispatch() { throw new Error("must not send"); } }, async () => []);
    expect((await unavailable.accept({ ...event, id: "run-45" }, `Bearer ${token}`)).status).toBe("unrouted");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("failed delivery is manually retryable, uncertain delivery and stale claims are never automatically replayed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ingress-retry-"));
  let calls = 0;
  try {
    const service = new ExternalNotificationService(dataDir, config,
      { async dispatch() { calls += 1; return receipt(calls === 1 ? "failed" : "uncertain"); } },
      async () => [target]);
    const accepted = await service.accept(event, `Bearer ${token}`);
    expect((await service.runDue()).failed).toBe(1);
    expect((await service.runDue()).claimed).toBe(0);
    service.retryFailed(accepted.event_uuid);
    expect((await service.runDue()).uncertain).toBe(1);
    expect((await service.runDue()).claimed).toBe(0);
    expect(() => service.retryFailed(accepted.event_uuid)).toThrow("Only definitively failed");
    const claimed = await service.accept({ ...event, id: "run-99", dedupe_key: undefined }, `Bearer ${token}`);
    new ExternalNotificationRepository(dataDir).claim(1);
    NotifierDatabase.open(dataDir).db.query("UPDATE external_notification_events SET updated_at=? WHERE event_uuid=?")
      .run("2025-01-01", claimed.event_uuid);
    expect((await service.runDue()).claimed).toBe(0);
    expect(service.list("uncertain", 10)).toHaveLength(2);
    expect(calls).toBe(2);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a vanished or missing subset of routed targets is never reported as completed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ingress-target-change-"));
  const phone = { id: "phone", channel: "bark" as const, domains: ["ops" as const], enabled: true };
  const both = { ...config, rules: [{ ...config.rules[0]!, targets: ["email:owner", "bark:phone"] }] };
  let targets = [target, phone];
  try {
    const service = new ExternalNotificationService(dataDir, both,
      { async dispatch() { return receipt("completed"); } }, async () => targets);
    const first = await service.accept(event, `Bearer ${token}`);
    expect(first.status).toBe("pending");
    expect((await service.runDue()).failed).toBe(1);
    expect(service.list("failed", 10)[0]?.route_targets).toEqual(["email:owner", "bark:phone"]);
    const second = await service.accept({ ...event, id: "run-43" }, `Bearer ${token}`);
    expect(second.status).toBe("pending");
    targets = [target];
    expect((await service.runDue()).claimed).toBe(1);
    expect(service.list("unrouted", 10)[0]?.event_uuid).toBe(second.event_uuid);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("HTTP event receiver bounds input and separates source credentials from operator access", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ingress-http-"));
  try {
    const service = new ExternalNotificationService(dataDir, config,
      { async dispatch() { return receipt("completed"); } }, async () => [target]);
    const handle = (request: Request) => handleExternalNotificationRoutes(request, new URL(request.url), service,
      (candidate) => { if (candidate.headers.get("authorization") !== "Bearer operator") throw new HttpError(401, "Operator required"); });
    const url = "http://local/api/integrations/notifications/events";
    const request = (body: unknown, credential = token) => new Request(url, {
      method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await expect(handle(request({ ...event, priority: 9 }))).rejects.toMatchObject({ status: 400 });
    await expect(handle(request({ ...event, targets: ["email:attacker"] })))
      .rejects.toMatchObject({ status: 400 });
    await expect(handle(request(event, "x".repeat(64)))).rejects.toMatchObject({ status: 401 });
    await expect(handle(request({ ...event, body: "x".repeat(17_000) }))).rejects.toMatchObject({ status: 413 });
    const response = await handle(request(event));
    expect(response?.status).toBe(202);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toMatchObject({ schema_version: 1, status: "pending", duplicate: false });
    await expect(handle(request({ ...event, title: "Different" }))).rejects.toMatchObject({ status: 409 });
    await expect(handle(new Request("http://local/api/notifications/events"))).rejects.toMatchObject({ status: 401 });
    const operator = await handle(new Request("http://local/api/notifications/events?status=pending&limit=1", {
      headers: { authorization: "Bearer operator" },
    }));
    expect((await operator?.json() as { events: unknown[] }).events).toHaveLength(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
