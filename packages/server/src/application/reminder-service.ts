import type {
  NotificationDispatchResult,
} from "./notification-dispatcher";
import {
  daysBetween,
  dueEscalationSlot,
  reminderDeliveryKey,
  reminderPriority,
  shanghaiClock,
  type ReminderDeliveryKind,
  type ReminderItem,
} from "../domains/reminder/reminder";
import { ReminderRepository } from "../repositories/reminder-repository";

export interface ReminderNotificationDispatcher {
  dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult>;
}

export interface ReminderRunReport {
  local_date: string;
  expired_items: number;
  active_items: number;
  due_windows: number;
  completed: number;
  failed: number;
  uncertain: number;
  skipped_existing: number;
  skipped_empty: number;
}

export class ReminderService {
  private readonly repository: ReminderRepository;

  constructor(input: {
    dataDir: string;
    dispatcher: ReminderNotificationDispatcher;
  }) {
    this.repository = new ReminderRepository(input.dataDir);
    this.dispatcher = input.dispatcher;
  }

  private readonly dispatcher: ReminderNotificationDispatcher;

  list(status: "active" | "completed" | "expired" | "all" = "active"): ReminderItem[] {
    return this.repository.list(status);
  }

  create(input: { title: unknown; deadline_local_date: unknown; importance: unknown }): ReminderItem {
    return this.repository.create(input);
  }

  complete(id: string): ReminderItem {
    return this.repository.complete(id);
  }

  reopen(id: string): ReminderItem {
    return this.repository.reopen(id);
  }

  async runDue(now = new Date()): Promise<ReminderRunReport> {
    const clock = shanghaiClock(now);
    const report: ReminderRunReport = {
      local_date: clock.local_date,
      expired_items: this.repository.expireBefore(clock.local_date, clock.now_iso),
      active_items: 0,
      due_windows: 0,
      completed: 0,
      failed: 0,
      uncertain: 0,
      skipped_existing: 0,
      skipped_empty: 0,
    };
    const active = this.repository.list("active");
    report.active_items = active.length;
    if (clock.hour >= 10) await this.runDailyDigest(active, clock, report);
    for (const reminder of active) {
      const remaining = daysBetween(clock.local_date, reminder.deadline_local_date);
      const slot = dueEscalationSlot(reminder.importance, remaining, clock.hour);
      if (slot !== undefined) await this.runEscalation(reminder, remaining, slot, clock, report);
    }
    return report;
  }

  private async runDailyDigest(
    active: ReminderItem[],
    clock: ReturnType<typeof shanghaiClock>,
    report: ReminderRunReport,
  ): Promise<void> {
    const deliveryKey = reminderDeliveryKey({
      kind: "daily_digest", local_date: clock.local_date, slot: 10,
    });
    if (this.isTerminal(deliveryKey, report)) return;
    const digestItems = active.filter((item) => daysBetween(clock.local_date, item.deadline_local_date) > 3);
    report.due_windows += 1;
    if (!digestItems.length) {
      this.repository.recordDelivery({
        delivery_key: deliveryKey, kind: "daily_digest", local_date: clock.local_date,
        slot: 10, status: "skipped_empty", result: { item_count: 0 }, now: clock.now_iso,
      });
      report.skipped_empty += 1;
      return;
    }
    await this.dispatchAndRecord({
      deliveryKey,
      kind: "daily_digest",
      localDate: clock.local_date,
      slot: 10,
      envelope: {
        schema_version: 1,
        id: deliveryKey,
        idempotency_key: deliveryKey,
        domain: "reminder",
        kind: "digest",
        title: "每日事项概览",
        body: dailyDigestBody(digestItems, clock.local_date),
        priority: 3,
        tags: ["calendar", "memo"],
      },
    }, report, clock.now_iso);
  }

  private async runEscalation(
    reminder: ReminderItem,
    daysRemaining: number,
    slot: number,
    clock: ReturnType<typeof shanghaiClock>,
    report: ReminderRunReport,
  ): Promise<void> {
    const deliveryKey = reminderDeliveryKey({
      kind: "escalation", reminder_id: reminder.id, local_date: clock.local_date, slot,
    });
    if (this.isTerminal(deliveryKey, report)) return;
    report.due_windows += 1;
    await this.dispatchAndRecord({
      deliveryKey,
      reminderId: reminder.id,
      kind: "escalation",
      localDate: clock.local_date,
      slot,
      envelope: {
        schema_version: 1,
        id: deliveryKey,
        idempotency_key: deliveryKey,
        domain: "reminder",
        kind: "reminder",
        title: `事项提醒 · 重要度 ${reminder.importance}`,
        body: `${reminder.title}\n截止：${reminder.deadline_local_date}（${remainingText(daysRemaining)}）`,
        priority: reminderPriority(reminder.importance),
        tags: ["alarm_clock", "memo", `importance-${reminder.importance}`],
        source: { source_id: `reminder:${reminder.id}` },
      },
    }, report, clock.now_iso);
  }

  private isTerminal(deliveryKey: string, report: ReminderRunReport): boolean {
    const existing = this.repository.getDelivery(deliveryKey);
    if (!existing || existing.status === "failed") return false;
    report.skipped_existing += 1;
    return true;
  }

  private async dispatchAndRecord(input: {
    deliveryKey: string;
    reminderId?: string;
    kind: ReminderDeliveryKind;
    localDate: string;
    slot: number;
    envelope: unknown;
  }, report: ReminderRunReport, now: string): Promise<void> {
    try {
      const result = await this.dispatcher.dispatch({
        envelope: input.envelope,
        member_id: "reminder.service",
      });
      const status = result.status === "completed" ? "completed"
        : result.status === "uncertain" ? "uncertain" : "failed";
      this.repository.recordDelivery({
        delivery_key: input.deliveryKey,
        ...(input.reminderId ? { reminder_id: input.reminderId } : {}),
        kind: input.kind,
        local_date: input.localDate,
        slot: input.slot,
        status,
        result,
        ...(status === "failed" ? { error: dispatchFailure(result) } : {}),
        now,
      });
      report[status] += 1;
    } catch (error) {
      this.repository.recordDelivery({
        delivery_key: input.deliveryKey,
        ...(input.reminderId ? { reminder_id: input.reminderId } : {}),
        kind: input.kind,
        local_date: input.localDate,
        slot: input.slot,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        now,
      });
      report.failed += 1;
    }
  }
}

function dailyDigestBody(items: ReminderItem[], localDate: string): string {
  const lines = ["以下事项距离截止日期超过 3 天："];
  for (const item of items) {
    const line = `• ${item.title}｜${item.deadline_local_date}｜重要度 ${item.importance}`;
    if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > 3_300) {
      lines.push(`… 还有 ${items.length - (lines.length - 1)} 项，请在 Totemora 中查看。`);
      break;
    }
    lines.push(line);
  }
  lines.push(`汇总日期：${localDate}`);
  return lines.join("\n");
}

function remainingText(days: number): string {
  return days === 0 ? "今天截止" : days === 1 ? "明天截止" : `还有 ${days} 天`;
}

function dispatchFailure(result: NotificationDispatchResult): string {
  const failed = result.deliveries.filter((item) => item.status !== "completed")
    .map((item) => `${item.channel}:${item.target_id}:${item.status}`);
  return failed.length ? failed.join(", ") : `notification dispatch ${result.status}`;
}
