import { expect, test } from "bun:test";

import { parseNotificationEnvelope } from "./notification-envelope";
import {
  RefreshingNotificationTargetPolicy,
  StaticNotificationTargetPolicy,
} from "./notification-target-policy";

const envelope = parseNotificationEnvelope({
  schema_version: 1,
  id: "digest-1",
  idempotency_key: "digest-1:delivery",
  domain: "finance",
  kind: "digest",
  title: "财经简报",
  body: "正文",
  priority: 3,
  tags: ["chart_with_upwards_trend"],
});

test("resolves enabled targets by domain and requested channel", async () => {
  const policy = new StaticNotificationTargetPolicy([
    { id: "phone", channel: "bark", domains: ["ai", "finance"], enabled: true },
    { id: "group", channel: "telegram", domains: ["finance"], enabled: true },
    { id: "finance-topic", channel: "ntfy", domains: ["finance"], enabled: true },
    { id: "memo-topic", channel: "ntfy", domains: ["reminder"], enabled: true },
    { id: "disabled", channel: "bark", domains: ["finance"], enabled: false },
  ]);

  expect((await policy.resolve(envelope)).map((target) => `${target.channel}:${target.id}`)).toEqual([
    "bark:phone",
    "telegram:group",
    "ntfy:finance-topic",
  ]);
  expect(await policy.resolve({ ...envelope, target_channels: ["ntfy"] })).toEqual([
    { id: "finance-topic", channel: "ntfy", domains: ["finance"], enabled: true },
  ]);
});

test("refreshes targets for every dispatch instead of freezing a startup snapshot", async () => {
  let targets = [{ id: "first", channel: "bark" as const, domains: ["finance" as const], enabled: true }];
  const policy = new RefreshingNotificationTargetPolicy([{
    async list() { return targets; },
  }]);

  expect((await policy.resolve(envelope)).map((target) => target.id)).toEqual(["first"]);
  targets = [{ id: "second", channel: "bark", domains: ["finance"], enabled: true }];
  expect((await policy.resolve(envelope)).map((target) => target.id)).toEqual(["second"]);
});

test("rejects duplicate or invalid public target definitions", () => {
  expect(() => new StaticNotificationTargetPolicy([
    { id: "same", channel: "ntfy", domains: ["ai"], enabled: true },
    { id: "same", channel: "ntfy", domains: ["finance"], enabled: true },
  ])).toThrow("Duplicate notification target");
  expect(() => new StaticNotificationTargetPolicy([
    { id: "bad target", channel: "bark", domains: ["ai"], enabled: true },
  ])).toThrow("target id is invalid");
});
