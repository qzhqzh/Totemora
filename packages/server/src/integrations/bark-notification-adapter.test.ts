import { expect, test } from "bun:test";

import { parseNotificationEnvelope } from "../domains/notification/notification-envelope";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";
import { BarkNotificationAdapter } from "./bark-notification-adapter";

const envelope = parseNotificationEnvelope({
  schema_version: 1,
  id: "finance:digest:window-1",
  idempotency_key: "finance:digest:window-1:delivery",
  domain: "finance",
  kind: "digest",
  title: "财经简报",
  body: "今日重点",
  priority: 3,
  tags: ["chart_with_upwards_trend"],
  source: {
    source_id: "finance:window-1",
    url: "https://example.test/finance/window-1",
  },
});

const target: NotificationTargetRef = {
  id: "primary",
  channel: "bark",
  domains: ["finance"],
  enabled: true,
};

test("maps a notification envelope to an explicit Bark target", async () => {
  let request: { targetId: string; message: Record<string, unknown> } | undefined;
  const adapter = new BarkNotificationAdapter({
    async pushTo(targetId, message) {
      request = { targetId, message };
      return { accepted: true, target_id: targetId, status: 200 };
    },
  });

  const receipt = await adapter.deliver(target, envelope);
  expect(request).toEqual({
    targetId: "primary",
    message: {
      id: "finance:digest:window-1",
      title: "财经简报",
      body: "今日重点",
      url: "https://example.test/finance/window-1",
    },
  });
  expect(JSON.parse(receipt.evidence)).toEqual({
    channel: "bark",
    target_id: "primary",
    status: 200,
  });
});

test("marks a mismatched Bark receipt uncertain", async () => {
  const adapter = new BarkNotificationAdapter({
    async pushTo() {
      return { accepted: true, target_id: "another-target", status: 200 };
    },
  });

  const error = await rejected(adapter.deliver(target, envelope));
  expect(error).toMatchObject({ outcomeUncertain: true });
});

async function rejected(promise: Promise<unknown>): Promise<Error & { outcomeUncertain?: boolean }> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
}
