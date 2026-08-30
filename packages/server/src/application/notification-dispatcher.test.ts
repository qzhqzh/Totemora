import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NotificationEnvelopeV1 } from "../domains/notification/notification-envelope";
import { StaticNotificationTargetPolicy } from "../domains/notification/notification-target-policy";
import {
  NotificationDispatcher,
  type NotificationChannelAdapter,
} from "./notification-dispatcher";

const envelope: NotificationEnvelopeV1 = {
  schema_version: 1,
  id: "digest-1",
  idempotency_key: "digest-1:window-1",
  domain: "ai",
  kind: "digest",
  title: "每日简报",
  body: "正文",
  priority: 3,
  tags: ["newspaper"],
};

test("dispatches once per target and replays completed receipts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-notification-dispatch-"));
  const calls = { bark: 0, telegram: 0, ntfy: 0 };
  const dispatcher = new NotificationDispatcher(dataDir, policy(), [
    adapter("bark", async () => { calls.bark += 1; return "Bark accepted 200"; }),
    adapter("telegram", async () => { calls.telegram += 1; return "Telegram accepted message 42"; }),
    adapter("ntfy", async () => { calls.ntfy += 1; return "ntfy accepted message abc"; }),
  ]);

  const first = await dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" });
  const replay = await dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" });
  expect(first).toMatchObject({ status: "completed" });
  expect(replay.deliveries.every((delivery) => delivery.replayed === true)).toBe(true);
  expect(calls).toEqual({ bark: 1, telegram: 1, ntfy: 1 });
  await rm(dataDir, { recursive: true, force: true });
});

test("retries only a target with a known failure", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-notification-partial-"));
  let barkCalls = 0;
  let ntfyCalls = 0;
  const dispatcher = new NotificationDispatcher(dataDir, new StaticNotificationTargetPolicy([
    { id: "phone", channel: "bark", domains: ["ai"], enabled: true },
    { id: "hotspot", channel: "ntfy", domains: ["ai"], enabled: true },
  ]), [
    adapter("bark", async () => { barkCalls += 1; return "Bark accepted 200"; }),
    adapter("ntfy", async () => {
      ntfyCalls += 1;
      if (ntfyCalls === 1) throw new Error("ntfy rejected request with HTTP 503");
      return "ntfy accepted message abc";
    }),
  ]);

  expect(await dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" }))
    .toMatchObject({ status: "partial" });
  const recovered = await dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" });
  expect(recovered).toMatchObject({ status: "completed" });
  expect(recovered.deliveries.find((item) => item.channel === "bark")?.replayed).toBe(true);
  expect({ barkCalls, ntfyCalls }).toEqual({ barkCalls: 1, ntfyCalls: 2 });
  await rm(dataDir, { recursive: true, force: true });
});

test("blocks automatic replay after an uncertain target outcome", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-notification-uncertain-"));
  let calls = 0;
  const uncertain = Object.assign(new Error("socket closed after request write"), { outcomeUncertain: true });
  const dispatcher = new NotificationDispatcher(dataDir, new StaticNotificationTargetPolicy([
    { id: "hotspot", channel: "ntfy", domains: ["ai"], enabled: true },
  ]), [adapter("ntfy", async () => { calls += 1; throw uncertain; })]);

  const first = await dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" });
  const replay = await dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" });
  expect(first).toMatchObject({ status: "uncertain", deliveries: [{ status: "uncertain" }] });
  expect(replay).toMatchObject({ status: "uncertain", deliveries: [{ status: "uncertain" }] });
  expect(calls).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});

test("keeps the aggregate uncertain when another target completed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-notification-mixed-uncertain-"));
  const uncertain = Object.assign(new Error("socket closed after request write"), { outcomeUncertain: true });
  const dispatcher = new NotificationDispatcher(dataDir, new StaticNotificationTargetPolicy([
    { id: "phone", channel: "bark", domains: ["ai"], enabled: true },
    { id: "hotspot", channel: "ntfy", domains: ["ai"], enabled: true },
  ]), [
    adapter("bark", async () => "Bark accepted 200"),
    adapter("ntfy", async () => { throw uncertain; }),
  ]);

  const result = await dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" });
  expect(result.status).toBe("uncertain");
  expect(result.deliveries.map((item) => item.status).sort()).toEqual(["completed", "uncertain"]);
  await rm(dataDir, { recursive: true, force: true });
});

function policy() {
  return new StaticNotificationTargetPolicy([
    { id: "phone", channel: "bark", domains: ["ai"], enabled: true },
    { id: "group", channel: "telegram", domains: ["ai"], enabled: true },
    { id: "hotspot", channel: "ntfy", domains: ["ai"], enabled: true },
  ]);
}

function adapter(
  channel: NotificationChannelAdapter["channel"],
  deliver: () => Promise<string>,
): NotificationChannelAdapter {
  return {
    channel,
    asset_id: `${channel}-notification`,
    deliver: async () => ({ accepted: true, evidence: await deliver() }),
  };
}
