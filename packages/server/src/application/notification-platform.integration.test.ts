import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BarkNotificationService } from "../bark-notification-service";
import { createNotificationPlatform } from "../bootstrap/notification-platform";
import { TelegramBotService } from "../telegram-bot-service";

test("existing Bark and Telegram services share one idempotent dispatcher with ntfy", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-notification-platform-"));
  const secretsDir = join(dataDir, "secrets");
  await mkdir(secretsDir, { recursive: true });
  await writeFile(join(secretsDir, "bark-device-key"), "test-device-key\n");
  await writeFile(join(secretsDir, "telegram-bot-token"), "123456:test-bot-token\n");
  await writeFile(join(secretsDir, "telegram-chat-ids"), "-1001234567890\n");

  const calls = { bark: 0, telegram: 0, ntfy: 0 };
  const bark = new BarkNotificationService(dataDir, (async () => {
    calls.bark += 1;
    return Response.json({ code: 200 });
  }) as unknown as typeof fetch);
  const telegram = new TelegramBotService(dataDir, (async () => {
    calls.telegram += 1;
    return Response.json({ ok: true, result: { message_id: 42 } });
  }) as unknown as typeof fetch);
  const platform = await createNotificationPlatform({
    dataDir,
    bark,
    telegram,
    telegramTargets: [{
      id: "news-group",
      chat_id: "-1001234567890",
      domains: ["ai"],
      enabled: true,
    }],
    ntfyTargets: [{
      id: "hotspot-topic",
      server_url: "https://ntfy.example.test",
      topic: "hotspot",
      authorization: "Bearer test-ntfy-token",
      domains: ["ai"],
      enabled: true,
    }],
    ntfyFetch: (async () => {
      calls.ntfy += 1;
      return Response.json({
        id: "ntfy-message-1",
        time: 1_787_968_800,
        event: "message",
        topic: "hotspot",
      });
    }) as unknown as typeof fetch,
  });
  const envelope = {
    schema_version: 1,
    id: "ai:digest:window-1",
    idempotency_key: "ai:digest:window-1:delivery",
    domain: "ai",
    kind: "digest",
    title: "每日重点",
    body: "三通道统一派发测试",
    priority: 3,
    tags: ["newspaper"],
    click_url: "https://example.test/digests/window-1",
  };

  const first = await platform.dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" });
  const replay = await platform.dispatcher.dispatch({ envelope, member_id: "qwen_intelligence" });
  expect(first.status).toBe("completed");
  expect(replay.deliveries.every((delivery) => delivery.replayed)).toBe(true);
  expect(calls).toEqual({ bark: 1, telegram: 1, ntfy: 1 });
  const publicResult = JSON.stringify({ first, replay });
  expect(publicResult).not.toContain("test-device-key");
  expect(publicResult).not.toContain("test-bot-token");
  expect(publicResult).not.toContain("test-ntfy-token");
  expect(publicResult).not.toContain("-1001234567890");
  expect(JSON.stringify(await platform.listTargets())).not.toContain("-1001234567890");
  await expect(createNotificationPlatform({
    dataDir,
    bark,
    telegram,
    telegramTargets: [{
      id: "untrusted-group", chat_id: "-1009999999999", domains: ["ai"], enabled: true,
    }],
    ntfyTargets: [],
  })).rejects.toThrow("not allowlisted");
  await writeFile(join(secretsDir, "bark-targets.json"), JSON.stringify([{
    id: "second-phone",
    device_key: "second-device-key",
    domains: ["ai"],
    enabled: true,
    server_url: "http://127.0.0.1:18080",
  }]));
  const refreshedTargets = JSON.stringify(await platform.listTargets());
  expect(refreshedTargets).toContain("second-phone");
  expect(refreshedTargets).not.toContain("second-device-key");
  await rm(dataDir, { recursive: true, force: true });
});
