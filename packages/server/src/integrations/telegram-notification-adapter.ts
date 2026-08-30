import type {
  NotificationChannelAdapter,
  NotificationChannelReceipt,
} from "../application/notification-dispatcher";
import type { NotificationEnvelopeV1 } from "../domains/notification/notification-envelope";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";

const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHAT_ID = /^-?[0-9]{1,20}$/;
const TELEGRAM_TEXT_LIMIT = 4_000;

export interface TelegramNotificationTargetConfig {
  id: string;
  chat_id: string;
}

export interface TelegramTextSender {
  sendText(chatId: string | number, text: string): Promise<{
    message_id: number;
    chat_id: string;
  }>;
}

export class TelegramNotificationAdapter implements NotificationChannelAdapter {
  readonly channel = "telegram" as const;
  readonly asset_id = "telegram-notification";
  private readonly chatIds = new Map<string, string>();

  constructor(
    private readonly service: TelegramTextSender,
    targets: TelegramNotificationTargetConfig[],
  ) {
    const actualChatIds = new Set<string>();
    for (const target of targets) {
      if (!TARGET_ID.test(target.id)) throw new Error("Telegram notification target id is invalid");
      if (!CHAT_ID.test(target.chat_id)) throw new Error(`Telegram chat_id is invalid for target ${target.id}`);
      if (this.chatIds.has(target.id)) throw new Error(`Duplicate Telegram notification target: ${target.id}`);
      if (actualChatIds.has(target.chat_id)) throw new Error("Duplicate Telegram chat destination");
      this.chatIds.set(target.id, target.chat_id);
      actualChatIds.add(target.chat_id);
    }
  }

  async deliver(
    target: NotificationTargetRef,
    envelope: NotificationEnvelopeV1,
  ): Promise<NotificationChannelReceipt> {
    if (target.channel !== this.channel) throw new Error(`Telegram adapter cannot deliver channel ${target.channel}`);
    const chatId = this.chatIds.get(target.id);
    if (!chatId) throw new Error(`Telegram notification target is not configured: ${target.id}`);
    let receipt: { message_id: number; chat_id: string };
    try {
      receipt = await this.service.sendText(chatId, telegramText(envelope));
    } catch (error) {
      throw sanitizedDeliveryError(error, chatId, target.id);
    }
    if (!Number.isInteger(receipt.message_id) || receipt.message_id <= 0 || receipt.chat_id !== chatId) {
      throw Object.assign(new Error(`Telegram returned an invalid acceptance receipt for target ${target.id}`), {
        outcomeUncertain: true,
      });
    }
    return {
      accepted: true,
      evidence: JSON.stringify({
        channel: this.channel,
        target_id: target.id,
        message_id: receipt.message_id,
      }),
    };
  }
}

function telegramText(envelope: NotificationEnvelopeV1): string {
  const prefix = `${envelope.title}\n\n`;
  const url = envelope.click_url ?? envelope.source?.url;
  const suffix = url ? `\n\n${url}` : "";
  const bodyLimit = Math.max(1, TELEGRAM_TEXT_LIMIT - prefix.length - suffix.length);
  const body = truncate(envelope.body, bodyLimit);
  return `${prefix}${body}${suffix}`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function sanitizedDeliveryError(error: unknown, chatId: string, targetId: string): Error {
  const detail = (error instanceof Error ? error.message : String(error))
    .split(chatId).join("[redacted-chat]")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .slice(0, 1_000);
  const wrapped = new Error(`Telegram delivery failed for target ${targetId}: ${detail}`);
  if (!isObject(error)) return wrapped;
  return Object.assign(wrapped, {
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(error.retryAfter instanceof Date ? { retryAfter: error.retryAfter } : {}),
    ...(typeof error.outcomeUncertain === "boolean" ? { outcomeUncertain: error.outcomeUncertain } : {}),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
