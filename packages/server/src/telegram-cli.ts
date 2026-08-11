import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { TelegramBotService } from "./telegram-bot-service";

const command = process.argv[2] ?? "doctor";
const dataDir = resolve(process.env.TOTEMORA_DATA_DIR ?? ".totemora");
const service = new TelegramBotService(dataDir);

if (command === "doctor") {
  const status = await service.status(true);
  console.log(JSON.stringify(status, null, 2));
  if (!status.healthy || !status.configured || !status.webhook_secret_configured || !status.webhook_registered) {
    process.exitCode = 1;
  }
} else if (command === "discover") {
  const chats = await service.discoverChats();
  console.log(JSON.stringify({ chats }, null, 2));
  if (!chats.length) {
    console.error("没有发现群消息；先把 Bot 加入群并发送 /start@你的Bot用户名。Webhook 已启用时需先删除 Webhook。 ");
    process.exitCode = 1;
  }
} else if (command === "setup") {
  await ensureWebhookSecret(dataDir);
  const publicBaseUrl = process.env.TOTEMORA_PUBLIC_BASE_URL?.trim();
  if (!publicBaseUrl) throw new Error("TOTEMORA_PUBLIC_BASE_URL is required for Telegram webhook setup");
  console.log(JSON.stringify(await service.setupWebhook(publicBaseUrl), null, 2));
} else if (command === "test") {
  const chatIds = await service.chatIds();
  if (!chatIds.length) throw new Error("Telegram chat allowlist is empty");
  const results = [];
  for (const chatId of chatIds) {
    results.push(await service.sendText(
      chatId,
      `🔥 Totemora 通道测试成功\n部落 Gateway：${new Date().toISOString()}\n发送 /tribe 或 /news 继续交互。`,
    ));
  }
  console.log(JSON.stringify({ sent: results }, null, 2));
} else {
  console.error("Usage: telegram-cli.ts doctor | discover | setup | test");
  process.exit(2);
}

async function ensureWebhookSecret(directory: string): Promise<void> {
  if (process.env.TOTEMORA_TELEGRAM_WEBHOOK_SECRET?.trim()) return;
  const secretDir = resolve(directory, "secrets");
  const path = resolve(secretDir, "telegram-webhook-secret");
  try {
    if ((await readFile(path, "utf8")).trim()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(secretDir, { recursive: true });
  await writeFile(path, `${randomBytes(32).toString("base64url")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
