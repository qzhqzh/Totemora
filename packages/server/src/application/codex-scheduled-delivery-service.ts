import { createHash } from "node:crypto";

import { ActionJournal, UncertainExternalEffectError } from "../action-journal";
import {
  CODEX_SCHEDULED_SUBSCRIPTION_LIMIT,
  type CodexScheduledDigest,
  type CodexScheduledSubscription,
} from "../domains/codex/codex-scheduled-subscription-types";
import {
  CodexScheduledDailyLimitError,
  CodexScheduledSubscriptionLimitError,
  CodexScheduledSubscriptionRepository,
} from "../repositories/codex-scheduled-subscription-repository";
import { TelegramBotService } from "../telegram-bot-service";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const RUN_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export class CodexScheduledDeliveryConfigurationError extends Error {}
export class CodexScheduledDeliveryUnauthorizedError extends Error {}
export class CodexScheduledDeliveryConflictError extends Error {}
export class CodexScheduledDeliveryUncertainError extends Error {}
export class CodexScheduledDeliveryFailedError extends Error {}

export interface CodexScheduledDeliveryServiceOptions {
  dataDir: string;
  publicBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class CodexScheduledDeliveryService {
  private readonly subscriptions: CodexScheduledSubscriptionRepository;
  private readonly telegram: TelegramBotService;
  private readonly journal: ActionJournal;

  constructor(private readonly options: CodexScheduledDeliveryServiceOptions) {
    this.subscriptions = new CodexScheduledSubscriptionRepository(options.dataDir);
    this.telegram = new TelegramBotService(options.dataDir, options.fetchImpl ?? fetch);
    this.journal = new ActionJournal(options.dataDir);
  }

  async overview(): Promise<{
    subscriptions: CodexScheduledSubscription[];
    subscription_limit: number;
    telegram_targets: Array<{ chat_id: string }>;
    mcp_endpoint?: string;
  }> {
    const endpoint = this.endpoint(false);
    return {
      subscriptions: this.subscriptions.listActive(),
      subscription_limit: CODEX_SCHEDULED_SUBSCRIPTION_LIMIT,
      telegram_targets: (await this.telegram.chatIds()).map((chatId) => ({ chat_id: chatId })),
      mcp_endpoint: endpoint,
    };
  }

  async createSubscription(input: { name: string; target_chat_id: string }) {
    const name = boundedText(input.name, "name", 120);
    const targetChatId = boundedText(input.target_chat_id, "target_chat_id", 32);
    if (!/^-?\d+$/.test(targetChatId)) {
      throw new CodexScheduledDeliveryConfigurationError("Telegram target chat ID 必须是数字");
    }
    const endpoint = this.endpoint(true)!;
    const targets = await this.telegram.chatIds();
    if (!targets.length) throw new CodexScheduledDeliveryConfigurationError("Telegram 群尚未配置");
    if (!targets.includes(targetChatId)) {
      throw new CodexScheduledDeliveryConfigurationError("目标 Telegram 群不在服务器白名单中");
    }
    const created = this.subscriptions.create({ name, target_chat_id: targetChatId });
    return {
      subscription: created.subscription,
      credential: {
        mcp_endpoint: endpoint,
        bearer_token: created.token,
        tool_name: "publish_scheduled_digest",
        prompt: scheduledTaskPrompt(name),
      },
    };
  }

  revokeSubscription(id: string, expectedRevision: number): CodexScheduledSubscription {
    return this.subscriptions.revoke(id, expectedRevision);
  }

  authorize(token: string): boolean {
    return Boolean(this.subscriptions.verify(token));
  }

  async publish(token: string, input: CodexScheduledDigest): Promise<{
    subscription_id: string;
    run_key: string;
    delivered: true;
    replayed: boolean;
    projection_pending?: true;
  }> {
    const subscription = this.subscriptions.verify(token);
    if (!subscription) throw new CodexScheduledDeliveryUnauthorizedError("定时任务订阅凭证无效或已撤销");
    const digest = validateDigest(input);
    const text = formatTelegramDigest(subscription.name, digest);
    const payloadHash = createHash("sha256").update(JSON.stringify(digest)).digest("hex");
    const deliveryWindow = asiaShanghaiDate(this.options.now?.() ?? new Date());
    const targetFingerprint = createHash("sha256").update(subscription.target_chat_id).digest("hex").slice(0, 16);
    this.subscriptions.assertDeliveryWindowAvailable(subscription.id, deliveryWindow, digest.run_key);
    let deliveryAttempted = false;
    let result: Awaited<ReturnType<ActionJournal["executeEffectOnce"]>>;
    try {
      result = await this.journal.executeEffectOnce({
        idempotency_key: `codex-scheduled:${subscription.id}:${digest.run_key}:telegram:${targetFingerprint}`,
        asset_id: "telegram-bot",
        member_id: "codex-supervisor",
        action: "publish_scheduled_digest",
        request: {
          subscription_id: subscription.id,
          run_key: digest.run_key,
          target_chat_id: subscription.target_chat_id,
          payload_hash: payloadHash,
        },
      }, async () => {
        this.subscriptions.reserveDeliveryWindow(subscription.id, deliveryWindow, digest.run_key);
        deliveryAttempted = true;
        const receipt = await this.telegram.sendText(subscription.target_chat_id, text);
        return `Telegram accepted message ${receipt.message_id} for chat …${subscription.target_chat_id.slice(-4)}`;
      });
    } catch (error) {
      if (error instanceof CodexScheduledDailyLimitError) throw error;
      if (error instanceof UncertainExternalEffectError) {
        const outward = new CodexScheduledDeliveryUncertainError(
          "Telegram 投递结果未知；为避免群内重复消息，服务器已禁止自动重放",
        );
        this.recordFailure(
          subscription.id,
          digest.run_key,
          "uncertain",
          outward.message,
          error.record.updated_at,
        );
        throw outward;
      }
      if (deliveryAttempted) {
        const outward = new CodexScheduledDeliveryFailedError(
          "Telegram 明确拒绝了本次投递，请在 Totemora 控制台检查配置",
        );
        this.recordFailure(subscription.id, digest.run_key, "failed", outward.message);
        throw outward;
      }
      throw new CodexScheduledDeliveryConflictError(
        "本周期的投递已完成、正在处理，或请求内容与首次调用不一致；服务器未再次发送",
      );
    }
    let projectionPending = false;
    try {
      this.subscriptions.recordDelivery(
        subscription.id,
        digest.run_key,
        "delivered",
        undefined,
        result.record.updated_at,
      );
    } catch {
      projectionPending = true;
    }
    return {
      subscription_id: subscription.id,
      run_key: digest.run_key,
      delivered: true,
      replayed: result.replayed,
      ...(projectionPending ? { projection_pending: true as const } : {}),
    };
  }

  private recordFailure(
    subscriptionId: string,
    runKey: string,
    status: "failed" | "uncertain",
    message: string,
    sourceAt?: string,
  ): void {
    try { this.subscriptions.recordDelivery(subscriptionId, runKey, status, message, sourceAt); }
    catch { /* Preserve the original delivery failure. */ }
  }

  private endpoint(required: boolean): string | undefined {
    if (!this.options.publicBaseUrl?.trim()) {
      if (required) throw new CodexScheduledDeliveryConfigurationError("TOTEMORA_PUBLIC_BASE_URL 尚未配置");
      return undefined;
    }
    try {
      const base = new URL(this.options.publicBaseUrl);
      if (base.protocol !== "https:") throw new Error("not HTTPS");
      return new URL("/mcp/codex-scheduled", base).toString();
    } catch {
      if (required) throw new CodexScheduledDeliveryConfigurationError("定时任务投递需要有效的 HTTPS TOTEMORA_PUBLIC_BASE_URL");
      return undefined;
    }
  }
}

export { CodexScheduledDailyLimitError, CodexScheduledSubscriptionLimitError };

export function formatTelegramDigest(subscriptionName: string, digest: CodexScheduledDigest): string {
  const header = `📬 ${subscriptionName}\n${digest.title}`;
  const sources = (digest.source_urls ?? []).slice(0, 3)
    .map((url, index) => `${index + 1}. ${truncate(url, 260)}`);
  const sourceBlock = sources.length ? `\n\n来源\n${sources.join("\n")}` : "";
  const occurred = digest.occurred_at ? `\n时间：${digest.occurred_at}` : "";
  const full = `${header}${occurred}\n\n${digest.body}${sourceBlock}`;
  if (full.length <= 4_000) return full;
  const marker = "\n\n…正文过长，已按 Telegram 单条消息上限截断。";
  const fixed = `${header}${occurred}\n\n`;
  const available = Math.max(0, 4_000 - fixed.length - marker.length - sourceBlock.length);
  return `${fixed}${digest.body.slice(0, available)}${marker}${sourceBlock}`.slice(0, 4_000);
}

function validateDigest(input: CodexScheduledDigest): CodexScheduledDigest {
  const runKey = boundedText(input.run_key, "run_key", 100);
  if (!RUN_KEY.test(runKey)) throw new Error("run_key 必须是稳定的 ASCII 周期标识");
  const title = boundedText(input.title, "title", 200);
  const body = boundedText(input.body, "body", 12_000);
  const sourceUrls = input.source_urls?.map((value) => {
    const candidate = boundedText(value, "source_url", 1_000);
    let parsed: URL;
    try { parsed = new URL(candidate); }
    catch { throw new Error("source_urls 必须是有效 HTTPS URL"); }
    if (parsed.protocol !== "https:") throw new Error("source_urls 只允许 HTTPS URL");
    return parsed.toString();
  });
  if (sourceUrls && sourceUrls.length > 5) throw new Error("source_urls 最多 5 项");
  let occurredAt: string | undefined;
  if (input.occurred_at !== undefined) {
    occurredAt = boundedText(input.occurred_at, "occurred_at", 100);
    if (Number.isNaN(Date.parse(occurredAt))) throw new Error("occurred_at 必须是有效时间");
  }
  return {
    run_key: runKey,
    title,
    body,
    ...(sourceUrls ? { source_urls: sourceUrls } : {}),
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
  };
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} 必须是 1-${maximum} 个字符的非空文本`);
  }
  return value.trim();
}

function scheduledTaskPrompt(name: string): string {
  return [
    `这是已订阅的定时任务“${name}”。`,
    "仅在本次定时任务成功形成最终报告后调用 publish_scheduled_digest；普通对话和中间进度禁止调用。",
    "每日任务的 run_key 使用 Asia/Shanghai 日期 YYYY-MM-DD，同一天重试必须复用同一个 run_key。",
    "服务器会把每份订阅限制为每个 Asia/Shanghai 自然日最多一条 Telegram 消息。",
    "title 保持简短，body 直接给出适合群聊阅读的最终摘要，重要事实附 source_urls；每次运行只调用一次。",
    "若投递工具返回错误，在任务结果中明确报告失败，不要改用其他会话或通知通道绕过订阅。",
  ].join("\n");
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function asiaShanghaiDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
