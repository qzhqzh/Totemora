import { expect, test } from "bun:test";

import {
  assertLocalDate,
  daysBetween,
  dueEscalationSlot,
  reminderDeliveryKey,
  shanghaiClock,
} from "./reminder";

test("uses Asia/Shanghai calendar boundaries", () => {
  expect(shanghaiClock(new Date("2026-08-29T16:05:00.000Z"))).toEqual({
    local_date: "2026-08-30",
    hour: 0,
    now_iso: "2026-08-29T16:05:00.000Z",
  });
  expect(daysBetween("2026-08-30", "2026-09-02")).toBe(3);
  expect(daysBetween("2026-08-30", "2026-08-29")).toBe(-1);
  expect(() => assertLocalDate("2026-02-30")).toThrow("real calendar date");
});

test("preserves legacy importance escalation windows and chooses one latest due slot", () => {
  expect(dueEscalationSlot(1, 1, 17)).toBe(10);
  expect(dueEscalationSlot(1, 1, 18)).toBe(18);
  expect(dueEscalationSlot(3, 0, 15)).toBe(12);
  expect(dueEscalationSlot(5, 0, 22)).toBe(22);
  expect(dueEscalationSlot(5, 4, 23)).toBeUndefined();
  expect(dueEscalationSlot(1, 0, 8)).toBeUndefined();
});

test("builds stable daily and per-item delivery keys", () => {
  expect(reminderDeliveryKey({ kind: "daily_digest", local_date: "2026-08-30", slot: 10 }))
    .toBe("reminder:daily:2026-08-30:10");
  expect(reminderDeliveryKey({
    kind: "escalation", reminder_id: "r-1", local_date: "2026-08-30", slot: 14,
  })).toBe("reminder:item:r-1:2026-08-30:14");
  expect(() => reminderDeliveryKey({
    kind: "escalation", local_date: "2026-08-30", slot: 14,
  })).toThrow("requires a reminder id");
});
