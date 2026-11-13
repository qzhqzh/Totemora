import { createHash } from "node:crypto";
import { ActionJournal, UncertainExternalEffectError } from "../action-journal";
import {
  ProjectRadarActionConflictError, ProjectRadarActionNotFoundError,
  type ProjectRadarAction, type ProjectRadarActionDecision,
} from "../domains/intelligence/project-radar-action";
import { TelegramBotService, TelegramDeliveryError, type TelegramUpdate } from "../telegram-bot-service";

export type ProjectRadarTelegramAction = Pick<ProjectRadarAction, "id" | "title" | "next_step" | "status" | "project_name"> & {
  evidence: Array<{ title: string; url: string }>;
};
export interface ProjectRadarTelegramOptions {
  dataDir: string;
  actions: {
    list(limit?: number): ProjectRadarTelegramAction[];
    decide(id: string, input: ProjectRadarActionDecision & { source: "telegram" }): ProjectRadarTelegramAction;
  };
  telegram?: Pick<TelegramBotService, "isAllowedChat" | "sendChoices" | "sendText" | "answerCallback">;
  fetchImpl?: typeof fetch;
}
export interface ProjectRadarTelegramResult {
  accepted: true;
  replayed?: boolean;
  ignored?: string;
  uncertain?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RADAR_COMMAND = /^\/radar(?:@[A-Za-z0-9_]{5,32})?$/i;

/** HTTP callers must verify the Telegram webhook secret before invoking this adapter. */
export class ProjectRadarTelegramController {
  private readonly telegram: NonNullable<ProjectRadarTelegramOptions["telegram"]>;
  private readonly journal: ActionJournal;

  constructor(private readonly options: ProjectRadarTelegramOptions) {
    this.telegram = options.telegram ?? new TelegramBotService(options.dataDir, options.fetchImpl ?? fetch);
    this.journal = new ActionJournal(options.dataDir);
  }

  accepts(update: TelegramUpdate): boolean {
    if (update?.callback_query) return typeof update.callback_query.data === "string" && update.callback_query.data.startsWith("ra:");
    return typeof update?.message?.text === "string" && RADAR_COMMAND.test(update.message.text.trim());
  }

  async handleUpdate(update: TelegramUpdate): Promise<ProjectRadarTelegramResult> {
    if (!this.accepts(update)) return { accepted: true, ignored: "unmatched_update" };
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return { accepted: true, ignored: "invalid_update" };
    const callback = update.callback_query;
    const chatId = callback ? callback.message?.chat.id : update.message?.chat.id;
    if (!Number.isSafeInteger(chatId) || !(await this.telegram.isAllowedChat(chatId!))) {
      return { accepted: true, ignored: "chat_not_allowlisted" };
    }
    if (callback && (typeof callback.id !== "string" || !callback.id || callback.id.length > 200
      || /[\u0000-\u001f\u007f]/u.test(callback.id))) return { accepted: true, ignored: "invalid_update" };
    try {
      const result = await this.journal.executeEffectOnce({
        ...journalIdentity(`telegram:radar:update:${update.update_id}`, "project_radar_update"),
        request: { chat_id: String(chatId), message_id: callback?.message?.message_id ?? update.message?.message_id,
          command: callback ? undefined : update.message?.text?.trim(),
          callback_id: callback ? digest(callback.id) : undefined, callback_data: callback?.data },
      }, async () => {
        try { return callback ? await this.handleCallback(callback, String(chatId)) : await this.sendActions(String(chatId)); }
        catch (error) {
          if (error instanceof UncertainExternalEffectError) throw uncertainEffect();
          throw error;
        }
      });
      return { accepted: true, replayed: result.replayed,
        ...(result.record.evidence?.startsWith("ignored:") ? { ignored: result.record.evidence.slice(8) } : {}) };
    } catch (error) {
      if (error instanceof UncertainExternalEffectError) return { accepted: true, replayed: false, uncertain: true };
      const ignored = reservationConflict(error);
      if (ignored) return { accepted: true, ignored };
      throw error;
    }
  }

  private async sendActions(chatId: string): Promise<string> {
    const actions = this.options.actions.list(3).slice(0, 3);
    let sent = 0;
    try {
      if (!actions.length) {
        await this.telegram.sendText(chatId, "当前没有项目行动建议；有符合项目目标且证据充分的情报时会在这里展示。");
        return "sent empty radar response";
      }
      for (const action of actions) {
        const interactive = action.status === "proposed" && UUID.test(action.id);
        const text = renderAction(action, interactive);
        if (interactive) {
          await this.telegram.sendChoices(chatId, text, [
            { label: "采纳", callback_data: `ra:${action.id}:a` },
            { label: "忽略", callback_data: `ra:${action.id}:d` },
          ]);
        } else await this.telegram.sendText(chatId, text);
        sent += 1;
      }
      return `sent ${sent} radar actions`;
    } catch (error) { throw deliveryFailure(error, sent > 0); }
  }

  private async handleCallback(callback: NonNullable<TelegramUpdate["callback_query"]>, chatId: string): Promise<string> {
    const callbackKey = digest(callback.id);
    try {
      const result = await this.journal.executeEffectOnce({
        ...journalIdentity(`telegram:radar:callback:${callbackKey}`, "project_radar_callback"),
        request: { chat_id: chatId, message_id: callback.message?.message_id, data: callback.data },
      }, async () => {
        const parsed = parseCallback(callback.data);
        if (!parsed) {
          await this.acknowledge(callback.id, "这个项目雷达按钮已失效，请发送 /radar 刷新。");
          return "ignored:invalid_callback";
        }
        let action: ProjectRadarTelegramAction;
        try {
          action = this.options.actions.decide(parsed.id, {
            decision: parsed.decision, idempotency_key: `telegram:radar:decision:${callbackKey}`, source: "telegram",
          });
        } catch (error) {
          if (error instanceof ProjectRadarActionNotFoundError) {
            await this.acknowledge(callback.id, "这个建议已不存在或已过期，请发送 /radar 刷新。");
            return "ignored:action_unavailable";
          }
          if (error instanceof ProjectRadarActionConflictError) {
            await this.acknowledge(callback.id, "这条建议已经处理，不能用旧按钮更改决定；请在 Web 查看。");
            return "ignored:decision_conflict";
          }
          throw new Error("Radar decision could not be recorded");
        }
        await this.acknowledge(callback.id, action.status === "accepted"
          ? "已采纳。行动建议已记录，可在 Web 查看后续任务草案。"
          : "已忽略这条行动建议。");
        return `decision:${action.status}`;
      });
      return result.record.evidence ?? "handled radar callback";
    } catch (error) {
      const ignored = reservationConflict(error);
      if (ignored) return `ignored:${ignored}`;
      throw error;
    }
  }

  private async acknowledge(callbackId: string, text: string): Promise<void> {
    try { await this.telegram.answerCallback(callbackId, text); }
    catch (error) {
      // Telegram rejects expired callback queries with a definitive 400; repeating them cannot help.
      if (error instanceof TelegramDeliveryError && !error.outcomeUncertain && error.status === 400) return;
      throw deliveryFailure(error);
    }
  }
}

function journalIdentity(idempotency_key: string, action: string) {
  return { idempotency_key, action, asset_id: "telegram-bot", member_id: "project-radar" };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function parseCallback(data: string | undefined): { id: string; decision: "accept" | "dismiss" } | undefined {
  if (!data || Buffer.byteLength(data, "utf8") > 64) return undefined;
  const match = /^ra:([^:]+):(a|d)$/.exec(data);
  return match && UUID.test(match[1]!) ? { id: match[1]!.toLowerCase(), decision: match[2] === "a" ? "accept" : "dismiss" } : undefined;
}
function renderAction(action: ProjectRadarTelegramAction, interactive: boolean): string {
  const status = action.status === "accepted" ? "已采纳" : action.status === "dismissed" ? "已忽略" : "待决定";
  const source = action.evidence.find((item) => safeEvidenceUrl(item.url));
  return [
    `项目雷达 · ${truncate(action.project_name, 80)} · ${status}`, truncate(action.title, 300),
    `建议下一步：${truncate(action.next_step, 1000)}`,
    source ? `来源：${truncate(source.title, 160)}\n${source.url}` : "来源请在 Totemora Web 的项目雷达中核对。",
    !interactive ? "请在 Totemora Web 的项目雷达查看详情与决定。" : undefined,
  ].filter(Boolean).join("\n\n");
}
function safeEvidenceUrl(value: string): boolean {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}
function truncate(value: string, maximum: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return safe.length > maximum ? `${safe.slice(0, maximum - 1)}…` : safe;
}
function deliveryFailure(error: unknown, partiallySent = false): Error {
  if (partiallySent || !(error instanceof TelegramDeliveryError) || error.outcomeUncertain) return uncertainEffect();
  return new TelegramDeliveryError("Telegram request was rejected", error.retryable, error.status, error.retryAfter);
}
function uncertainEffect(): Error & { outcomeUncertain: true } {
  return Object.assign(new Error("Telegram delivery outcome is uncertain; automatic replay is blocked"), { outcomeUncertain: true as const });
}
function reservationConflict(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message === "Idempotency key was reused with a different request") return "idempotency_conflict";
  if (error.message.startsWith("Action is already executing for idempotency key ")) return "in_progress";
  return undefined;
}
