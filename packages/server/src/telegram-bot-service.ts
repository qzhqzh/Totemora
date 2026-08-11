import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { StateDatabase } from "./state-database";

export type TelegramFeedbackSignal = "valuable" | "not_valuable" | "duplicate" | "too_late";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string; title?: string };
    from?: { id: number; is_bot: boolean; first_name: string; username?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; is_bot: boolean; first_name: string; username?: string };
    message?: { message_id: number; chat: { id: number; type: string; title?: string } };
  };
}

export interface TelegramStatus {
  configured: boolean;
  chat_count: number;
  webhook_secret_configured: boolean;
  webhook_registered?: boolean;
  webhook_url?: string;
  pending_update_count?: number;
  webhook_last_error?: string;
  channel_status: string;
  consecutive_failures: number;
  retry_after?: string;
  healthy?: boolean;
  bot_username?: string;
  error?: string;
}

interface TelegramConfig {
  apiBase: string;
  token: string;
  chatIds: string[];
  webhookSecret?: string;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface ChannelRow {
  status: string;
  consecutive_failures: number;
  retry_after: string | null;
  last_error: string | null;
}

export class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfter?: Date,
    readonly outcomeUncertain = false,
  ) {
    super(message);
  }
}

export class TelegramBotService {
  private readonly state: StateDatabase;

  constructor(
    private readonly dataDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.state = StateDatabase.open(dataDir);
  }

  async configured(): Promise<boolean> {
    const config = await this.loadConfig();
    return Boolean(config?.chatIds.length);
  }

  async chatIds(): Promise<string[]> {
    return (await this.loadConfig())?.chatIds ?? [];
  }

  async status(checkHealth = false): Promise<TelegramStatus> {
    const config = await this.loadConfig();
    const channel = this.channel();
    if (!config) {
      return {
        configured: false,
        chat_count: 0,
        webhook_secret_configured: false,
        channel_status: "unconfigured",
        consecutive_failures: 0,
      };
    }
    const status: TelegramStatus = {
      configured: config.chatIds.length > 0,
      chat_count: config.chatIds.length,
      webhook_secret_configured: Boolean(config.webhookSecret),
      channel_status: channel.status,
      consecutive_failures: channel.consecutive_failures,
      retry_after: channel.retry_after ?? undefined,
      error: channel.last_error ?? undefined,
    };
    if (checkHealth) {
      try {
        const me = await this.api<{ username?: string }>(config, "getMe", {});
        const webhook = await this.api<{
          url: string;
          pending_update_count: number;
          last_error_message?: string;
        }>(config, "getWebhookInfo", {});
        status.healthy = true;
        status.bot_username = me.username;
        status.webhook_registered = Boolean(webhook.url);
        status.webhook_url = webhook.url || undefined;
        status.pending_update_count = webhook.pending_update_count;
        status.webhook_last_error = webhook.last_error_message;
      } catch (error) {
        status.healthy = false;
        status.error = safeMessage(error, config.token);
      }
    }
    return status;
  }

  async verifyWebhookSecret(provided: string | null): Promise<void> {
    const config = await this.requireConfig();
    if (!config.webhookSecret) throw new Error("Telegram webhook secret is not configured");
    const actual = Buffer.from(provided ?? "");
    const expected = Buffer.from(config.webhookSecret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new TelegramDeliveryError("Telegram webhook authorization failed", false, 401);
    }
  }

  async isAllowedChat(chatId: number | string): Promise<boolean> {
    return (await this.chatIds()).includes(String(chatId));
  }

  async pushCandidate(chatId: string, message: {
    id: string;
    title: string;
    body: string;
    url: string;
  }): Promise<{ message_id: number; chat_id: string }> {
    const text = truncate(`${message.title}\n\n${message.body}`, 4_000);
    return this.send(chatId, text, {
      inline_keyboard: [
        [{ text: "查看来源", url: message.url }],
        [
          { text: "👍 有价值", callback_data: `intel:${message.id}:valuable` },
          { text: "👎 没价值", callback_data: `intel:${message.id}:not_valuable` },
        ],
        [
          { text: "♻️ 重复", callback_data: `intel:${message.id}:duplicate` },
          { text: "⏰ 太晚", callback_data: `intel:${message.id}:too_late` },
        ],
      ],
    });
  }

  async sendText(chatId: string | number, text: string): Promise<{ message_id: number; chat_id: string }> {
    return this.send(String(chatId), truncate(text, 4_000));
  }

  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    const config = await this.requireConfig();
    await this.api(config, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: truncate(text, 180),
      show_alert: false,
    });
  }

  async setupWebhook(publicBaseUrl: string): Promise<{ webhook_url: string; bot_username?: string }> {
    const config = await this.requireConfig();
    if (!config.chatIds.length) throw new Error("Telegram chat allowlist is empty");
    if (!config.webhookSecret) throw new Error("Telegram webhook secret is not configured");
    const base = new URL(publicBaseUrl);
    if (base.protocol !== "https:") throw new Error("Telegram webhook requires a public HTTPS base URL");
    const webhookUrl = new URL("/api/integrations/telegram/webhook", base).toString();
    await this.api(config, "setWebhook", {
      url: webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
      max_connections: 4,
    });
    await this.api(config, "setMyCommands", {
      commands: [
        { command: "help", description: "查看部落 Bot 用法" },
        { command: "tribe", description: "查看在线成员" },
        { command: "news", description: "查看最近情报候选" },
      ],
    });
    const me = await this.api<{ username?: string }>(config, "getMe", {});
    return { webhook_url: webhookUrl, bot_username: me.username };
  }

  async discoverChats(): Promise<Array<{ id: string; type: string; title?: string }>> {
    const config = await this.requireConfig();
    const updates = await this.api<TelegramUpdate[]>(config, "getUpdates", {
      timeout: 0,
      limit: 100,
      allowed_updates: ["message"],
    });
    const chats = new Map<string, { id: string; type: string; title?: string }>();
    for (const update of updates) {
      const chat = update.message?.chat;
      if (chat) chats.set(String(chat.id), { id: String(chat.id), type: chat.type, title: chat.title });
    }
    return [...chats.values()];
  }

  private async send(
    chatId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<{ message_id: number; chat_id: string }> {
    const config = await this.requireConfig();
    if (!config.chatIds.includes(chatId)) throw new Error(`Telegram chat is not allowlisted: ${chatId}`);
    const channel = this.channel();
    if (channel.status === "open" && channel.retry_after && Date.parse(channel.retry_after) > Date.now()) {
      throw new TelegramDeliveryError(`Telegram circuit is open until ${channel.retry_after}`, true, undefined, new Date(channel.retry_after));
    }
    try {
      const result = await this.api<{ message_id: number }>(config, "sendMessage", {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      this.success();
      return { message_id: result.message_id, chat_id: chatId };
    } catch (error) {
      const deliveryError = error instanceof TelegramDeliveryError
        ? error
        : new TelegramDeliveryError(`Telegram request failed: ${safeMessage(error, config.token)}`, true, undefined, undefined, true);
      this.failure(deliveryError.message, deliveryError.retryAfter);
      throw deliveryError;
    }
  }

  private async api<T>(config: TelegramConfig, method: string, payload: Record<string, unknown>): Promise<T> {
    const target = new URL(`./bot${config.token}/${method}`, ensureSlash(config.apiBase));
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch (error) {
      throw new TelegramDeliveryError(`Telegram request failed: ${safeMessage(error, config.token)}`, true, undefined, undefined, true);
    }
    let raw: string;
    try { raw = (await response.text()).slice(0, 4_000); }
    catch (error) {
      throw new TelegramDeliveryError(
        `Telegram response body failed (${response.status}): ${safeMessage(error, config.token)}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
        undefined,
        response.ok,
      );
    }
    let body: TelegramResponse<T>;
    try { body = JSON.parse(raw) as TelegramResponse<T>; }
    catch { throw new TelegramDeliveryError(`Telegram returned invalid JSON (${response.status})`, response.status >= 500, response.status, undefined, response.ok); }
    if (!response.ok || !body.ok || body.result === undefined) {
      const status = body.error_code ?? response.status;
      const retryAfter = body.parameters?.retry_after
        ? new Date(Date.now() + body.parameters.retry_after * 1_000)
        : undefined;
      const retryable = status === 408 || status === 429 || status >= 500;
      const outcomeUncertain = response.ok && body.ok === true && body.result === undefined;
      throw new TelegramDeliveryError(
        `Telegram API ${method} failed (${status}): ${body.description ?? "unknown error"}`,
        retryable,
        status,
        retryAfter,
        outcomeUncertain,
      );
    }
    return body.result;
  }

  private channel(): ChannelRow {
    return (this.state.db.query(`
      SELECT status,consecutive_failures,retry_after,last_error FROM channel_state WHERE channel='telegram'
    `).get() as ChannelRow | null) ?? {
      status: "ready", consecutive_failures: 0, retry_after: null, last_error: null,
    };
  }

  private success(): void {
    this.state.db.query(`
      INSERT INTO channel_state(channel,status,consecutive_failures,retry_after,last_error,updated_at)
      VALUES('telegram','ready',0,NULL,NULL,?)
      ON CONFLICT(channel) DO UPDATE SET
        status='ready',consecutive_failures=0,retry_after=NULL,last_error=NULL,updated_at=excluded.updated_at
    `).run(new Date().toISOString());
  }

  private failure(error: string, requestedRetry?: Date): void {
    const prior = this.channel();
    const failures = prior.consecutive_failures + 1;
    const open = failures >= 3 || Boolean(requestedRetry);
    const retryAfter = requestedRetry?.toISOString()
      ?? (open ? new Date(Date.now() + 30 * 60_000).toISOString() : null);
    this.state.db.query(`
      INSERT INTO channel_state(channel,status,consecutive_failures,retry_after,last_error,updated_at)
      VALUES('telegram',?,?,?,?,?)
      ON CONFLICT(channel) DO UPDATE SET
        status=excluded.status,consecutive_failures=excluded.consecutive_failures,
        retry_after=excluded.retry_after,last_error=excluded.last_error,updated_at=excluded.updated_at
    `).run(open ? "open" : "degraded", failures, retryAfter, error.slice(0, 500), new Date().toISOString());
  }

  private async requireConfig(): Promise<TelegramConfig> {
    const config = await this.loadConfig();
    if (!config) throw new TelegramDeliveryError("Telegram Bot token is not configured", false);
    return config;
  }

  private async loadConfig(): Promise<TelegramConfig | undefined> {
    const token = (process.env.TOTEMORA_TELEGRAM_BOT_TOKEN ?? await this.loadSecret("telegram-bot-token") ?? "").trim();
    if (!token) return undefined;
    const rawChatIds = process.env.TOTEMORA_TELEGRAM_CHAT_IDS ?? await this.loadSecret("telegram-chat-ids") ?? "";
    const chatIds = [...new Set(rawChatIds.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
    if (chatIds.some((item) => !/^-?\d+$/.test(item))) throw new Error("Telegram chat IDs must be numeric");
    const webhookSecret = (
      process.env.TOTEMORA_TELEGRAM_WEBHOOK_SECRET
      ?? await this.loadSecret("telegram-webhook-secret")
      ?? ""
    ).trim() || undefined;
    if (webhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
      throw new Error("Telegram webhook secret contains unsupported characters");
    }
    const api = new URL(process.env.TOTEMORA_TELEGRAM_API_BASE ?? "https://api.telegram.org");
    const local = ["127.0.0.1", "localhost", "::1"].includes(api.hostname);
    if (!["http:", "https:"].includes(api.protocol) || (api.protocol !== "https:" && !local)) {
      throw new Error("Telegram API base must use HTTPS unless it is localhost");
    }
    return { apiBase: api.toString(), token, chatIds, webhookSecret };
  }

  private async loadSecret(name: string): Promise<string | undefined> {
    try { return (await readFile(resolve(this.dataDir, "secrets", name), "utf8")).trim() || undefined; }
    catch { return undefined; }
  }
}

export function parseTelegramFeedback(data: string | undefined): { candidateId: string; signal: TelegramFeedbackSignal } | undefined {
  const match = data?.match(/^intel:([0-9a-f-]{36}):(valuable|not_valuable|duplicate|too_late)$/i);
  if (!match) return undefined;
  return { candidateId: match[1]!, signal: match[2]!.toLowerCase() as TelegramFeedbackSignal };
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function safeMessage(error: unknown, token: string): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(token, "[redacted]");
}
