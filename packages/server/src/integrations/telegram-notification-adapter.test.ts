import { expect, test } from "bun:test";

import { parseNotificationEnvelope } from "../domains/notification/notification-envelope";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";
import { TelegramNotificationAdapter } from "./telegram-notification-adapter";

const envelope = parseNotificationEnvelope({
  schema_version: 1,
  id: "ai:digest:window-1",
  idempotency_key: "ai:digest:window-1:delivery",
  domain: "ai",
  kind: "digest",
  title: "每日重点",
  body: "值得关注的三条消息",
  priority: 3,
  tags: ["newspaper"],
  click_url: "https://example.test/digests/window-1",
});

const target: NotificationTargetRef = {
  id: "news-group",
  channel: "telegram",
  domains: ["ai"],
  enabled: true,
};

test("resolves a public Telegram alias without exposing the chat id in evidence", async () => {
  const chatId = "-1001234567890";
  let request: { chatId: string | number; text: string } | undefined;
  const adapter = new TelegramNotificationAdapter({
    async sendText(actualChatId, text) {
      request = { chatId: actualChatId, text };
      return { message_id: 42, chat_id: String(actualChatId) };
    },
  }, [{ id: "news-group", chat_id: chatId }]);

  const receipt = await adapter.deliver(target, envelope);
  expect(request).toEqual({
    chatId,
    text: "每日重点\n\n值得关注的三条消息\n\nhttps://example.test/digests/window-1",
  });
  expect(receipt.evidence).not.toContain(chatId);
  expect(JSON.parse(receipt.evidence)).toEqual({
    channel: "telegram",
    target_id: "news-group",
    message_id: 42,
  });
});

test("redacts the Telegram chat id and preserves uncertain delivery metadata", async () => {
  const chatId = "-1001234567890";
  const adapter = new TelegramNotificationAdapter({
    async sendText() {
      throw Object.assign(new Error(`socket closed while sending to ${chatId}`), {
        retryable: true,
        outcomeUncertain: true,
      });
    },
  }, [{ id: "news-group", chat_id: chatId }]);

  const error = await rejected(adapter.deliver(target, envelope));
  expect(error.message).not.toContain(chatId);
  expect(error).toMatchObject({ retryable: true, outcomeUncertain: true });
});

test("bounds Telegram text while retaining the destination URL", async () => {
  let text = "";
  const adapter = new TelegramNotificationAdapter({
    async sendText(chatId, value) {
      text = value;
      return { message_id: 43, chat_id: String(chatId) };
    },
  }, [{ id: "news-group", chat_id: "-1001234567890" }]);

  await adapter.deliver(target, { ...envelope, body: "中".repeat(8_000) });
  expect(text.length).toBeLessThanOrEqual(4_000);
  expect(text).toContain("…\n\nhttps://example.test/digests/window-1");
});

test("rejects duplicate or invalid Telegram destinations", () => {
  const service = { async sendText(chatId: string | number) {
    return { message_id: 1, chat_id: String(chatId) };
  } };
  expect(() => new TelegramNotificationAdapter(service, [
    { id: "first", chat_id: "-1001234567890" },
    { id: "second", chat_id: "-1001234567890" },
  ])).toThrow("Duplicate Telegram chat destination");
  expect(() => new TelegramNotificationAdapter(service, [
    { id: "bad target", chat_id: "not-a-chat" },
  ])).toThrow("target id is invalid");
});

async function rejected(promise: Promise<unknown>): Promise<Error & {
  retryable?: boolean;
  outcomeUncertain?: boolean;
}> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
}
