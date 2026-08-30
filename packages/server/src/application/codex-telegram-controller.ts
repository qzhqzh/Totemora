import { ActionJournal, UncertainExternalEffectError } from "../action-journal";
import type { CodexInteraction, CodexSupervisorStatus, CodexThreadRecord } from "../domains/codex/codex-supervisor-types";
import { TelegramBotService, type TelegramUpdate } from "../telegram-bot-service";

export interface CodexTelegramOperations {
  getStatus(): CodexSupervisorStatus;
  listThreads(input?: { mode?: "observed" | "managed"; limit?: number }): CodexThreadRecord[];
  listInteractions(input?: { status?: CodexInteraction["status"]; limit?: number }): CodexInteraction[];
  answerInteraction(input: {
    id: string; expected_revision: number; selected_option_id?: string;
    actor_id?: string; channel?: "web" | "mcp" | "telegram";
  }): Promise<CodexInteraction>;
}

export interface CodexTelegramControllerOptions {
  dataDir: string;
  operations: CodexTelegramOperations;
  fetchImpl?: typeof fetch;
  publicBaseUrl?: string;
  now?: () => Date;
}

export class CodexTelegramController {
  private readonly telegram: TelegramBotService;
  private readonly journal: ActionJournal;
  private readonly now: () => Date;
  private readonly webUrl?: string;

  constructor(private readonly options: CodexTelegramControllerOptions) {
    this.telegram = new TelegramBotService(options.dataDir, options.fetchImpl ?? fetch);
    this.journal = new ActionJournal(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.webUrl = codexWebUrl(options.publicBaseUrl);
  }

  accepts(update: TelegramUpdate): boolean {
    if (update.callback_query?.data?.startsWith("codex:")) return true;
    return ["/codex", "/decisions"].includes(commandOf(update));
  }

  async handleUpdate(update: TelegramUpdate) {
    const chatId = update.callback_query?.message?.chat.id ?? update.message?.chat.id;
    if (chatId === undefined || !(await this.telegram.isAllowedChat(chatId))) {
      return { accepted: true, ignored: "chat_not_allowlisted" };
    }
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const command = commandOf(update);
    try {
      const result = await this.journal.executeEffectOnce({
        idempotency_key: `telegram:codex:update:${update.update_id}`,
        asset_id: "telegram-bot", member_id: "codex-supervisor", action: "handle_codex_command",
        request: { update_id: update.update_id, chat_id: String(chatId), command },
      }, async () => this.sendCommandReply(String(chatId), command));
      return { accepted: true, replayed: result.replayed };
    } catch (error) {
      if (error instanceof UncertainExternalEffectError) return { accepted: true, replayed: false, uncertain: true };
      throw error;
    }
  }

  async runScheduled(): Promise<{ notified: number; daily_summaries: number }> {
    if (!this.options.operations.getStatus().enabled || !(await this.telegram.configured())) {
      return { notified: 0, daily_summaries: 0 };
    }
    const notified = await this.pushNewInteractions();
    const dailySummaries = await this.pushDailySummary();
    return { notified, daily_summaries: dailySummaries };
  }

  private async handleCallback(callback: NonNullable<TelegramUpdate["callback_query"]>) {
    const match = callback.data?.match(/^codex:([0-9a-f-]{36}):([0-2])$/i);
    if (!match) {
      await this.telegram.answerCallback(callback.id, "这个 Codex 按钮已失效");
      return { accepted: true, ignored: "invalid_codex_callback" };
    }
    const interaction = this.options.operations.listInteractions({ limit: 500 }).find((item) => item.id === match[1]);
    if (!interaction || interaction.status !== "open") {
      await this.telegram.answerCallback(callback.id, "这项请求已经处理或失效");
      return { accepted: true, replayed: true };
    }
    if (!["suggest", "decision"].includes(interaction.kind)) {
      await this.telegram.answerCallback(callback.id, "系统审批只能在 Web 监控台处理");
      return { accepted: true, ignored: "web_only_interaction" };
    }
    const option = interaction.options[Number(match[2])];
    if (!option) {
      await this.telegram.answerCallback(callback.id, "这个选项已经失效");
      return { accepted: true, ignored: "invalid_option" };
    }
    try {
      await this.options.operations.answerInteraction({
        id: interaction.id, expected_revision: interaction.revision,
        selected_option_id: option.id, actor_id: "telegram-operator", channel: "telegram",
      });
      await this.telegram.answerCallback(callback.id, `已选择：${option.label}`);
      return { accepted: true, replayed: false };
    } catch (error) {
      await this.telegram.answerCallback(callback.id, "处理失败，请打开 Web 监控台刷新后重试");
      return { accepted: true, replayed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async sendCommandReply(chatId: string, command: string): Promise<string> {
    if (command === "/codex") {
      const sent = await this.telegram.sendText(chatId, this.summary("Codex 托管现场"));
      return `sent Codex status message ${sent.message_id}`;
    }
    const open = this.options.operations.listInteractions({ status: "open", limit: 100 });
    const decisions = open.filter((item) => ["suggest", "decision"].includes(item.kind));
    const approvals = open.filter((item) => item.kind === "approval");
    const interaction = decisions[0];
    if (interaction) {
      const sent = await this.sendInteraction(chatId, interaction, `待决策 ${decisions.length} · Web 审批 ${approvals.length}`);
      return `sent Codex decision message ${sent.message_id}`;
    }
    const text = approvals.length
      ? `当前有 ${approvals.length} 项系统审批待处理。审批不会在 Telegram 开放。${this.webLine()}`
      : "当前没有待处理的 Codex 建议或决策。";
    const sent = await this.telegram.sendText(chatId, text);
    return `sent Codex decision summary ${sent.message_id}`;
  }

  private async pushNewInteractions(): Promise<number> {
    const delivered = new Set((await this.journal.list())
      .filter((item) => item.idempotency_key.startsWith("codex:interaction:") && ["completed", "uncertain"].includes(item.status))
      .map((item) => item.idempotency_key));
    const interactions = this.options.operations.listInteractions({ status: "open", limit: 100 })
      .filter((item) => ["suggest", "decision", "approval"].includes(item.kind))
      .sort((left, right) => Number(right.kind === "approval") - Number(left.kind === "approval"));
    let notified = 0;
    const failures: string[] = [];
    for (const chatId of await this.telegram.chatIds()) {
      const pending = interactions.filter((item) => !delivered.has(interactionKey(item.id, chatId))).slice(0, 5);
      for (const interaction of pending) {
        const key = interactionKey(interaction.id, chatId);
        try {
          const result = await this.journal.executeEffectOnce({
            idempotency_key: key, asset_id: "telegram-bot", member_id: "codex-supervisor",
            action: "notify_codex_interaction", request: { chat_id: chatId, interaction_id: interaction.id, revision: interaction.revision },
          }, async () => {
            const sent = await this.sendInteraction(chatId, interaction);
            return `Telegram accepted Codex interaction message ${sent.message_id}`;
          });
          if (!result.replayed) notified += 1;
        } catch (error) {
          if (!(error instanceof UncertainExternalEffectError)) failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (failures.length) throw new Error(`Codex Telegram notification failures: ${failures.slice(0, 3).join("; ")}`);
    return notified;
  }

  private async pushDailySummary(): Promise<number> {
    const clock = shanghaiClock(this.now());
    if (clock.hour !== 8 || clock.minute !== 30) return 0;
    let sentCount = 0;
    for (const chatId of await this.telegram.chatIds()) {
      const result = await this.journal.executeEffectOnce({
        idempotency_key: `codex:daily:${clock.date}:${chatId}`,
        asset_id: "telegram-bot", member_id: "codex-supervisor", action: "push_codex_daily_summary",
        request: { chat_id: chatId, date: clock.date },
      }, async () => {
        const sent = await this.telegram.sendText(chatId, this.summary("Codex 每日监督摘要"));
        return `Telegram accepted daily Codex summary ${sent.message_id}`;
      });
      if (!result.replayed) sentCount += 1;
    }
    return sentCount;
  }

  private sendInteraction(chatId: string, interaction: CodexInteraction, prefix?: string) {
    const text = [prefix, `${interaction.kind === "approval" ? "系统审批" : interaction.kind === "suggest" ? "建议" : "需要决策"} · ${interaction.title}`, interaction.body,
      interaction.kind === "approval" ? `审批仅限 Web。${this.webLine()}` : undefined].filter(Boolean).join("\n\n");
    if (["suggest", "decision"].includes(interaction.kind) && interaction.options.length) {
      return this.telegram.sendChoices(chatId, text, interaction.options.map((option, index) => ({
        label: option.label, callback_data: `codex:${interaction.id}:${index}`,
      })));
    }
    return this.telegram.sendText(chatId, text);
  }

  private summary(title: string): string {
    const status = this.options.operations.getStatus();
    const managed = this.options.operations.listThreads({ mode: "managed", limit: 100 });
    const open = this.options.operations.listInteractions({ status: "open", limit: 100 });
    const phaseCounts = managed.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.phase]: (counts[item.phase] ?? 0) + 1 }), {});
    return [title, `App Server：${status.connected ? "已连接" : status.enabled ? "未连接" : "Supervisor 未启用"}`,
      `已发现 ${status.observed_threads} · Codex 正在运行 ${status.running_threads}`,
      `Totemora 托管中 ${status.managed_threads} · 正在续跑 ${status.active_managed_threads}`,
      `待决策/审批 ${open.length}`, `阶段：${Object.entries(phaseCounts).map(([phase, count]) => `${phase} ${count}`).join(" · ") || "无托管任务"}`, this.webLine()].join("\n");
  }

  private webLine(): string { return this.webUrl ? `Web：${this.webUrl}` : "Web：请打开 Totemora 的 /codex"; }
}

function commandOf(update: TelegramUpdate): string {
  const text = update.message?.text?.trim() ?? "";
  return text.startsWith("/") ? text.split(/\s+/, 1)[0]!.split("@")[0]!.toLowerCase() : "";
}

function interactionKey(interactionId: string, chatId: string): string { return `codex:interaction:${interactionId}:telegram:${chatId}`; }

function codexWebUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL("/codex", value); return url.protocol === "https:" ? url.toString() : undefined; }
  catch { return undefined; }
}

function shanghaiClock(date: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? "0";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), minute: Number(get("minute")) };
}
