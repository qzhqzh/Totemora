export const REMINDER_IMPORTANCE_VALUES = [1, 3, 5] as const;
export const REMINDER_STATUS_VALUES = ["active", "completed", "expired"] as const;

export type ReminderImportance = typeof REMINDER_IMPORTANCE_VALUES[number];
export type ReminderStatus = typeof REMINDER_STATUS_VALUES[number];
export type ReminderDeliveryKind = "daily_digest" | "escalation";
export type ReminderDeliveryStatus = "completed" | "failed" | "uncertain" | "skipped_empty";

export interface ReminderItem {
  id: string;
  title: string;
  deadline_local_date: string;
  importance: ReminderImportance;
  status: ReminderStatus;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  expired_at?: string;
  legacy_ref?: string;
}

export interface ShanghaiClock {
  local_date: string;
  hour: number;
  now_iso: string;
}

export interface ReminderDeliveryWindow {
  delivery_key: string;
  reminder_id?: string;
  kind: ReminderDeliveryKind;
  local_date: string;
  slot: number;
  status: ReminderDeliveryStatus;
  attempts: number;
  result?: unknown;
  last_error?: string;
  legacy_ref?: string;
  created_at: string;
  updated_at: string;
}

const ESCALATION_SLOTS: Readonly<Record<ReminderImportance, Readonly<Record<number, readonly number[]>>>> = {
  1: { 3: [10], 2: [10], 1: [10, 18], 0: [9, 14, 20] },
  3: { 3: [10, 18], 2: [10, 18], 1: [10, 14, 20], 0: [8, 12, 16, 20] },
  5: { 3: [10, 14, 20], 2: [10, 14, 20], 1: [8, 12, 16, 20], 0: [8, 10, 12, 14, 16, 18, 20, 22] },
};

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export function shanghaiClock(now = new Date()): ShanghaiClock {
  if (Number.isNaN(now.getTime())) throw new Error("Reminder clock requires a valid date");
  const parts = Object.fromEntries(
    SHANGHAI_FORMATTER.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    local_date: assertLocalDate(`${parts.year}-${parts.month}-${parts.day}`),
    hour: Number(parts.hour),
    now_iso: now.toISOString(),
  };
}

export function assertReminderTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("Reminder title must be a string");
  const title = value.trim();
  if (!title || title.length > 240 || /[\u0000-\u001F\u007F]/.test(title)) {
    throw new Error("Reminder title must contain 1-240 safe characters");
  }
  return title;
}

export function assertLocalDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Reminder deadline must use YYYY-MM-DD");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) {
    throw new Error("Reminder deadline must be a real calendar date");
  }
  return value;
}

export function assertReminderImportance(value: unknown): ReminderImportance {
  if (!REMINDER_IMPORTANCE_VALUES.includes(value as ReminderImportance)) {
    throw new Error("Reminder importance must be 1, 3, or 5");
  }
  return value as ReminderImportance;
}

export function daysBetween(localDate: string, deadline: string): number {
  const start = parseLocalDate(localDate);
  const end = parseLocalDate(deadline);
  return Math.round((end - start) / 86_400_000);
}

export function dueEscalationSlot(
  importance: ReminderImportance,
  daysRemaining: number,
  currentHour: number,
): number | undefined {
  if (!Number.isInteger(currentHour) || currentHour < 0 || currentHour > 23) {
    throw new Error("Reminder hour must be between 0 and 23");
  }
  const slots = ESCALATION_SLOTS[importance][daysRemaining];
  return slots ? [...slots].reverse().find((slot) => slot <= currentHour) : undefined;
}

export function reminderPriority(importance: ReminderImportance): 3 | 4 | 5 {
  return importance === 1 ? 3 : importance === 3 ? 4 : 5;
}

export function reminderDeliveryKey(input: {
  kind: ReminderDeliveryKind;
  local_date: string;
  slot: number;
  reminder_id?: string;
}): string {
  if (input.kind === "daily_digest") return `reminder:daily:${input.local_date}:${input.slot}`;
  if (!input.reminder_id) throw new Error("Escalation delivery key requires a reminder id");
  return `reminder:item:${input.reminder_id}:${input.local_date}:${input.slot}`;
}

function parseLocalDate(value: string): number {
  const valid = assertLocalDate(value);
  const [year, month, day] = valid.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}
