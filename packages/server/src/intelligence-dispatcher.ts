import { ActionJournal } from "./action-journal";
import type { NotifierClient } from "@totemora/notifier/client";
import { StateDatabase } from "./state-database";
import { BarkDeliveryError, BarkNotificationService } from "./bark-notification-service";
import {
  IntelligenceCandidateStore,
  type IntelligenceCandidate,
  type IntelligenceDomain,
} from "./intelligence-candidate-store";
import { MemberStateStore } from "./member-state-store";
import { SpecialistTaskRepository, type SpecialistServiceDefinition } from "./specialist-service";
import { TelegramBotService, TelegramDeliveryError } from "./telegram-bot-service";

class IntelligenceDispatchError extends Error {
  constructor(
    readonly failures: Error[],
    readonly retryable: boolean,
    readonly retryAfter?: Date,
  ) {
    super(failures.map((failure) => failure.message).join("; "));
  }
}

class NotificationOutcomeUnknownError extends Error {}

export class IntelligenceDispatcher {
  private readonly candidates: IntelligenceCandidateStore;
  private readonly bark: BarkNotificationService;
  private readonly telegram: TelegramBotService;
  private readonly journal: ActionJournal;
  private readonly specialistTasks: SpecialistTaskRepository;

  constructor(
    private readonly dataDir: string,
    private readonly memberState: MemberStateStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly notifier?: Pick<NotifierClient, "dispatch" | "listTargets">,
    private readonly deferCandidatePush: () => boolean = () => false,
  ) {
    this.candidates = new IntelligenceCandidateStore(dataDir);
    this.bark = new BarkNotificationService(dataDir, fetchImpl);
    this.telegram = new TelegramBotService(dataDir, fetchImpl);
    this.journal = new ActionJournal(dataDir);
    this.specialistTasks = new SpecialistTaskRepository(dataDir);
  }

  async notificationConfigured(domain: IntelligenceDomain): Promise<boolean> {
    if (this.notifier) return (await this.notifier.listTargets()).some((target) => target.enabled && target.domains.includes(domain));
    return (await this.bark.targetIds(domain)).length > 0 || (await this.telegram.configured());
  }

  async barkStatus(domain: IntelligenceDomain, checkHealth = false) {
    if (this.notifier) {
      const configured = (await this.notifier.listTargets()).some((target) => target.enabled
        && target.channel === "bark" && target.domains.includes(domain));
      return { configured, channel_status: configured ? "ready" as const : "unconfigured" as const,
        consecutive_failures: 0, targets: [], ...(checkHealth ? { healthy: undefined } : {}) };
    }
    return this.bark.status(checkHealth, domain);
  }

  async telegramStatus(checkHealth = false) {
    if (this.notifier) {
      const targets = (await this.notifier.listTargets()).filter((target) => target.enabled && target.channel === "telegram");
      return { configured: targets.length > 0, chat_count: targets.length, webhook_secret_configured: false,
        channel_status: targets.length ? "ready" : "unconfigured", consecutive_failures: 0 };
    }
    return this.telegram.status(checkHealth);
  }

  async pushNext(
    domain: IntelligenceDomain,
    minimumIntervalMs: number,
    serviceId: SpecialistServiceDefinition["id"],
  ): Promise<IntelligenceCandidate | undefined> {
    if (domain === "ai" && this.deferCandidatePush()) return undefined;
    if (!(await this.notificationConfigured(domain))) return undefined;
    await this.candidates.releaseBlocked();
    const candidate = await this.candidates.claimNext(minimumIntervalMs, new Date(), domain);
    if (!candidate) return undefined;
    try {
      const failures = this.notifier ? await this.dispatchViaNotifier(domain, candidate.member_id, `candidate:${candidate.id}`,
        candidate.headline, candidate.brief, candidate.url, this.callbackUrl(candidate)) : await this.pushBark(candidate, domain);
      if (!this.notifier) failures.push(...await settleDeliveries((await this.telegram.chatIds()).map((chatId) => async () => {
        await this.journal.executeEffectOnce({
          idempotency_key: `candidate:${candidate.id}:telegram:${chatId}`, asset_id: "telegram-bot",
          member_id: candidate.member_id, action: "push_notification",
          request: { candidate_id: candidate.id, domain, chat_id: chatId, item_url: candidate.url },
        }, async () => {
          const result = await this.telegram.pushCandidate(chatId, {
            id: candidate.id, title: candidate.headline, body: candidate.brief, url: candidate.url,
          });
          return `Telegram chat ${chatId} accepted message ${result.message_id}`;
        });
      })));
      if (failures.length) throw aggregateFailures(failures);
      await this.candidates.complete(candidate.id, candidate.claim_token);
      const task = this.specialistTasks.findByResultRef(serviceId, candidate.scan_id);
      if (task) this.specialistTasks.appendEvent(task.id, {
        type: "external_receipt", stage: "dispatch", actor_id: candidate.member_id,
        summary: `已配置通知目标均接受 ${domain} 候选 ${candidate.id}；这不等同于用户已阅读`,
      });
      return { ...candidate, status: "pushed", pushed_at: new Date().toISOString() };
      } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const deliveryError = deliveryMetadata(error);
      const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
      if (error instanceof NotificationOutcomeUnknownError) {
        await this.candidates.markDeliveryUnknown(candidate.id, candidate.claim_token, message);
      } else if (deliveryError?.retryAfter && deliveryError.retryAfter.getTime() > Date.now()) {
        await this.candidates.block(candidate.id, candidate.claim_token, message, deliveryError.retryAfter);
      } else if (deliveryError?.retryable && candidate.attempt_count < delays.length) {
        const retryAt = new Date(Date.now() + delays[Math.max(0, candidate.attempt_count - 1)]!);
        await this.candidates.retry(candidate.id, candidate.claim_token, message, retryAt);
      } else {
        await this.candidates.fail(candidate.id, message, new Date(), candidate.claim_token);
      }
      await this.memberState.remember({
        member_id: candidate.member_id, kind: "system_failure", verified: true, source_id: candidate.id,
        summary: `${domain} 候选消息推送失败：${message.slice(0, 300)}`,
      });
      throw error;
    }
  }

  async pushDirect(
    domain: IntelligenceDomain,
    workflowId: string,
    index: number,
    memberId: string,
    message: { title: string; body: string; url?: string; id?: string },
  ): Promise<void> {
    if (this.notifier) {
      const failures = await this.dispatchViaNotifier(domain, memberId, `${workflowId}:${domain}:${index}`,
        message.title, message.body, message.url, message.url);
      if (failures.length) throw aggregateFailures(failures);
      return;
    }
    const failures = await settleDeliveries((await this.bark.targetIds(domain)).map((targetId) => async () => {
      await this.journal.executeEffectOnce({
        idempotency_key: `${workflowId}:bark:${domain}:${targetId}:${index}`, asset_id: "internal-bark",
        member_id: memberId, action: "push_notification",
        request: { domain, target_id: targetId, index, title: message.title, item_url: message.url },
      }, async () => {
        const result = await this.bark.pushTo(targetId, message);
        return `Bark target ${targetId} accepted request with status ${result.status}`;
      });
    }));
    failures.push(...await settleDeliveries((await this.telegram.chatIds()).map((chatId) => async () => {
      await this.journal.executeEffectOnce({
        idempotency_key: `${workflowId}:telegram:${domain}:${index}:${chatId}`, asset_id: "telegram-bot",
        member_id: memberId, action: "push_notification",
        request: { domain, index, chat_id: chatId, title: message.title, item_url: message.url },
      }, async () => {
        const result = await this.telegram.sendText(
          chatId,
          [message.title, "", message.body, message.url ? `\n${message.url}` : ""].join("\n").trim(),
        );
        return `Telegram chat ${chatId} accepted message ${result.message_id}`;
      });
    })));
    if (failures.length) throw aggregateFailures(failures);
  }

  private async dispatchViaNotifier(domain: IntelligenceDomain, memberId: string, key: string,
    title: string, body: string, sourceUrl?: string, clickUrl?: string): Promise<Error[]> {
    const safeSource = sourceUrl && isSafeExternalUrl(sourceUrl) ? sourceUrl : undefined;
    const safeClick = clickUrl && isSafeExternalUrl(clickUrl) ? clickUrl : undefined;
    const receipt = await this.notifier!.dispatch({ member_id: memberId, envelope: {
      schema_version: 1, id: key, idempotency_key: key,
      domain, kind: "immediate", title, body, priority: 3, tags: [domain],
      source: { source_id: key, ...(safeSource ? { url: safeSource } : {}) },
      ...(safeClick ? { click_url: safeClick } : {}),
    } });
    if (receipt.status === "uncertain") throw new NotificationOutcomeUnknownError("Notifier delivery outcome is uncertain; manual reconciliation required");
    if (receipt.status === "completed") return [];
    return [Object.assign(new Error(`Notifier delivery ${receipt.status}; ${receipt.deliveries
      .filter((delivery) => delivery.status !== "completed")
      .map((delivery) => `${delivery.channel}:${delivery.target_id}:${delivery.status}`).join(", ")}`),
      { retryable: receipt.status !== "unconfigured" })];
  }

  private async pushBark(candidate: IntelligenceCandidate, domain: IntelligenceDomain): Promise<Error[]> {
    return settleDeliveries((await this.bark.targetIds(domain)).map((targetId) => async () => {
      await this.journal.executeEffectOnce({
        idempotency_key: `candidate:${candidate.id}:bark:${targetId}`, asset_id: "internal-bark",
        member_id: candidate.member_id, action: "push_notification",
        request: { candidate_id: candidate.id, domain, target_id: targetId, title: candidate.headline, item_url: candidate.url },
      }, async () => {
        const result = await this.bark.pushTo(targetId, {
          title: candidate.headline, body: candidate.brief,
          url: this.callbackUrl(candidate), id: candidate.id,
        });
        return `Bark target ${targetId} accepted request with status ${result.status}`;
      });
    }));
  }

  private callbackUrl(candidate: IntelligenceCandidate): string | undefined {
    if (!isSafeExternalUrl(candidate.url)) return undefined;
    const base = process.env.TOTEMORA_PUBLIC_BASE_URL?.trim();
    if (!base || !isSafeExternalUrl(base)) return candidate.url;
    const state = StateDatabase.open(this.dataDir);
    const previous = state.db.query("SELECT payload_json FROM records WHERE namespace=? AND id=?")
      .get("notification:callback", candidate.id) as { payload_json: string } | null;
    if (previous) return JSON.parse(previous.payload_json) as string;
    const token = this.candidates.createOpenCallback(candidate.id, candidate.url);
    const url = new URL(`/r/${encodeURIComponent(token)}`, base).toString();
    state.putRecord("notification:callback", candidate.id, url);
    return url;
  }
}

async function settleDeliveries(deliveries: Array<() => Promise<void>>): Promise<Error[]> {
  const results = await Promise.allSettled(deliveries.map((deliver) => deliver()));
  return results.flatMap((result) => result.status === "rejected"
    ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
    : []);
}

function aggregateFailures(failures: Error[]): IntelligenceDispatchError {
  const metadata = failures.map(deliveryMetadata).filter((item) => item !== undefined);
  const retryAfter = metadata.map((item) => item.retryAfter).filter((item): item is Date => Boolean(item))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return new IntelligenceDispatchError(failures, metadata.some((item) => item.retryable), retryAfter);
}

function deliveryMetadata(error: unknown): { retryable: boolean; retryAfter?: Date } | undefined {
  if (error instanceof IntelligenceDispatchError) return error;
  if (error instanceof BarkDeliveryError) return { retryable: error.retryable, retryAfter: error.retryAfter };
  if (error instanceof TelegramDeliveryError) return { retryable: error.retryable, retryAfter: error.retryAfter };
  if (error instanceof Error && "retryable" in error && typeof error.retryable === "boolean") {
    return { retryable: error.retryable };
  }
  return undefined;
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
