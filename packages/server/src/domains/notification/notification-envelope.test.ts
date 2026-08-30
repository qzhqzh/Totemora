import { expect, test } from "bun:test";

import {
  NotificationEnvelopeValidationError,
  parseNotificationEnvelope,
} from "./notification-envelope";

test("validates and normalizes a three-channel notification envelope", () => {
  expect(parseNotificationEnvelope({
    schema_version: 1,
    id: "reminder:42:2026-09-01",
    idempotency_key: "reminder:42:2026-09-01:10",
    domain: "reminder",
    kind: "reminder",
    title: "  提醒事项  ",
    body: "第一行\n第二行",
    priority: 4,
    tags: ["alarm_clock", "memo", "memo"],
    source: {
      source_id: "legacy:memo:42",
      url: "https://example.com/reminders/42",
      occurred_at: "2026-09-01T02:00:00+08:00",
    },
    click_url: "https://example.com/reminders/42",
    image_url: "https://example.com/reminder.png",
    target_channels: ["bark", "telegram", "ntfy", "ntfy"],
  })).toEqual({
    schema_version: 1,
    id: "reminder:42:2026-09-01",
    idempotency_key: "reminder:42:2026-09-01:10",
    domain: "reminder",
    kind: "reminder",
    title: "提醒事项",
    body: "第一行\n第二行",
    priority: 4,
    tags: ["alarm_clock", "memo"],
    source: {
      source_id: "legacy:memo:42",
      url: "https://example.com/reminders/42",
      occurred_at: "2026-08-31T18:00:00.000Z",
    },
    click_url: "https://example.com/reminders/42",
    image_url: "https://example.com/reminder.png",
    target_channels: ["bark", "telegram", "ntfy"],
  });
});

test("rejects unsupported domains, credential URLs, and control characters", () => {
  const base = {
    schema_version: 1,
    id: "message-1",
    idempotency_key: "message-1:delivery",
    domain: "ai",
    kind: "digest",
    title: "标题",
    body: "正文",
    priority: 3,
    tags: [],
  };
  expect(() => parseNotificationEnvelope({ ...base, domain: "misc" }))
    .toThrow(NotificationEnvelopeValidationError);
  expect(() => parseNotificationEnvelope({ ...base, click_url: "https://user:secret@example.com" }))
    .toThrow("without embedded credentials");
  expect(() => parseNotificationEnvelope({ ...base, title: "bad\nline" }))
    .toThrow("single line");
  expect(() => parseNotificationEnvelope({ ...base, body: "bad\u0000body" }))
    .toThrow("safe characters");
});

test("does not accept arbitrary target identifiers in the envelope", () => {
  expect(() => parseNotificationEnvelope({
    schema_version: 1,
    id: "message-1",
    idempotency_key: "message-1:delivery",
    domain: "ai",
    kind: "digest",
    title: "标题",
    body: "正文",
    priority: 3,
    tags: [],
    target_channels: ["private-device-id"],
  })).toThrow("target_channels must be one of bark, telegram, ntfy");
});
