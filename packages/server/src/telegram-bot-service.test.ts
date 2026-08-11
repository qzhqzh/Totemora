import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActionJournal, UncertainExternalEffectError } from "./action-journal";
import { parseTelegramFeedback, TelegramBotService, TelegramDeliveryError } from "./telegram-bot-service";

test("Telegram Bot sends an allowlisted group message with bounded feedback buttons", async () => {
  const dataDir = await telegramDataDir("totemora-telegram-push-");
  const requests: Array<{ method: string; body: Record<string, any> }> = [];
  const service = new TelegramBotService(dataDir, (async (input, init) => {
    const method = String(input).split("/").at(-1)!;
    requests.push({ method, body: JSON.parse(String(init?.body)) });
    if (method === "getMe") return Response.json({ ok: true, result: { username: "totemora_test_bot" } });
    return Response.json({ ok: true, result: { message_id: 42 } });
  }) as typeof fetch);

  const result = await service.pushCandidate("-100123", {
    id: "12345678-1234-1234-1234-123456789abc",
    title: "重要变化",
    body: "这是一条可验证情报。",
    url: "https://example.com/news",
  });
  expect(result).toEqual({ message_id: 42, chat_id: "-100123" });
  expect(requests[0]).toMatchObject({ method: "sendMessage", body: { chat_id: "-100123" } });
  expect(requests[0]!.body.reply_markup.inline_keyboard).toContainEqual([
    { text: "👍 有价值", callback_data: "intel:12345678-1234-1234-1234-123456789abc:valuable" },
    { text: "👎 没价值", callback_data: "intel:12345678-1234-1234-1234-123456789abc:not_valuable" },
  ]);
  expect(await service.status(true)).toMatchObject({
    configured: true, healthy: true, bot_username: "totemora_test_bot", chat_count: 1,
  });
  expect(parseTelegramFeedback("intel:12345678-1234-1234-1234-123456789abc:duplicate"))
    .toEqual({ candidateId: "12345678-1234-1234-1234-123456789abc", signal: "duplicate" });
  await rm(dataDir, { recursive: true, force: true });
});

test("Telegram setup registers a secret webhook and scoped group commands", async () => {
  const dataDir = await telegramDataDir("totemora-telegram-setup-");
  const requests: Array<{ method: string; body: Record<string, any> }> = [];
  const service = new TelegramBotService(dataDir, (async (input, init) => {
    const method = String(input).split("/").at(-1)!;
    requests.push({ method, body: JSON.parse(String(init?.body)) });
    if (method === "getMe") return Response.json({ ok: true, result: { username: "totemora_test_bot" } });
    return Response.json({ ok: true, result: true });
  }) as typeof fetch);
  const result = await service.setupWebhook("https://tribe.example.com/base");
  expect(result).toEqual({
    webhook_url: "https://tribe.example.com/api/integrations/telegram/webhook",
    bot_username: "totemora_test_bot",
  });
  expect(requests.find((item) => item.method === "setWebhook")?.body).toMatchObject({
    url: "https://tribe.example.com/api/integrations/telegram/webhook",
    secret_token: "webhook_secret",
    allowed_updates: ["message", "callback_query"],
  });
  expect(requests.find((item) => item.method === "setMyCommands")?.body.commands).toHaveLength(3);
  await rm(dataDir, { recursive: true, force: true });
});

test("Telegram opens its circuit on an API retry_after response", async () => {
  const dataDir = await telegramDataDir("totemora-telegram-circuit-");
  let calls = 0;
  const service = new TelegramBotService(dataDir, (async () => {
    calls += 1;
    return Response.json({
      ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 },
    }, { status: 429 });
  }) as unknown as typeof fetch);
  await expect(service.sendText("-100123", "test")).rejects.toBeInstanceOf(TelegramDeliveryError);
  expect(await service.status()).toMatchObject({ channel_status: "open", consecutive_failures: 1 });
  await expect(service.sendText("-100123", "test")).rejects.toThrow("circuit is open");
  expect(calls).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});

test("Telegram success without a receipt becomes uncertain and is not replayed", async () => {
  const dataDir = await telegramDataDir("totemora-telegram-uncertain-");
  let calls = 0;
  const service = new TelegramBotService(dataDir, (async () => {
    calls += 1;
    return Response.json({ ok: true });
  }) as unknown as typeof fetch);
  const journal = new ActionJournal(dataDir);
  const input = {
    idempotency_key: "telegram:missing-receipt", asset_id: "telegram-bot",
    member_id: "qwen_intelligence", action: "push_notification",
    request: { chat_id: "-100123", body: "test" },
  };
  await expect(journal.executeEffectOnce(input, async () => {
    const result = await service.sendText("-100123", "test");
    return `message ${result.message_id}`;
  })).rejects.toBeInstanceOf(UncertainExternalEffectError);
  await expect(journal.executeEffectOnce(input, async () => {
    calls += 1;
    return "duplicate";
  })).rejects.toBeInstanceOf(UncertainExternalEffectError);
  expect(calls).toBe(1);
  expect((await journal.list())[0]).toMatchObject({ status: "uncertain", attempts: 1 });
  await rm(dataDir, { recursive: true, force: true });
});

async function telegramDataDir(prefix: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const secrets = join(dataDir, "secrets");
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, "telegram-bot-token"), "123456:test_token\n");
  await writeFile(join(secrets, "telegram-chat-ids"), "-100123\n");
  await writeFile(join(secrets, "telegram-webhook-secret"), "webhook_secret\n");
  return dataDir;
}
