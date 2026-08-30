import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReminderRepository } from "../repositories/reminder-repository";
import type { NotificationDispatchResult } from "./notification-dispatcher";
import { ReminderService, type ReminderNotificationDispatcher } from "./reminder-service";

test("runs the legacy daily and escalation schedules exactly once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-reminder-service-"));
  const calls: Array<{ envelope: Record<string, unknown>; member_id: string }> = [];
  const service = new ReminderService({ dataDir, dispatcher: dispatcher(async (input) => {
    calls.push(input as typeof calls[number]);
    return result("completed", String((input.envelope as { id: string }).id));
  }) });
  try {
    service.create({ title: "Future", deadline_local_date: "2026-09-04", importance: 1 });
    service.create({ title: "Tomorrow", deadline_local_date: "2026-08-31", importance: 1 });
    service.create({ title: "Expired", deadline_local_date: "2026-08-29", importance: 5 });

    await expect(service.runDue(new Date("2026-08-30T02:00:00.000Z"))).resolves.toMatchObject({
      local_date: "2026-08-30", expired_items: 1, active_items: 2,
      due_windows: 2, completed: 2, failed: 0,
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.envelope)).toEqual([
      expect.objectContaining({ domain: "reminder", kind: "digest", priority: 3 }),
      expect.objectContaining({ domain: "reminder", kind: "reminder", priority: 3 }),
    ]);
    expect(calls.every((call) => call.member_id === "reminder.service")).toBeTrue();

    await expect(service.runDue(new Date("2026-08-30T02:01:00.000Z"))).resolves.toMatchObject({
      due_windows: 0, completed: 0, skipped_existing: 2,
    });
    expect(calls).toHaveLength(2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("retries failed dispatches but never automatically replays uncertain outcomes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-reminder-retry-"));
  let attempts = 0;
  const service = new ReminderService({ dataDir, dispatcher: dispatcher(async (input) => {
    attempts += 1;
    const id = String((input.envelope as { id: string }).id);
    return result(attempts === 1 ? "failed" : "completed", id);
  }) });
  try {
    const reminder = service.create({ title: "Due", deadline_local_date: "2026-08-30", importance: 1 });
    await service.runDue(new Date("2026-08-30T01:00:00.000Z"));
    await service.runDue(new Date("2026-08-30T01:01:00.000Z"));
    expect(attempts).toBe(2);
    const key = `reminder:item:${reminder.id}:2026-08-30:9`;
    expect(new ReminderRepository(dataDir).getDelivery(key)).toMatchObject({
      status: "completed", attempts: 2,
    });

    const uncertainData = join(dataDir, "uncertain");
    let uncertainCalls = 0;
    const uncertain = new ReminderService({
      dataDir: uncertainData,
      dispatcher: dispatcher(async (input) => {
        uncertainCalls += 1;
        return result("uncertain", String((input.envelope as { id: string }).id));
      }),
    });
    uncertain.create({ title: "Unknown", deadline_local_date: "2026-08-30", importance: 1 });
    await uncertain.runDue(new Date("2026-08-30T01:00:00.000Z"));
    await uncertain.runDue(new Date("2026-08-30T01:01:00.000Z"));
    expect(uncertainCalls).toBe(1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("records an empty daily window without calling external notification channels", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-reminder-empty-"));
  let calls = 0;
  const service = new ReminderService({
    dataDir,
    dispatcher: dispatcher(async () => { calls += 1; return result("completed", "unused"); }),
  });
  try {
    await expect(service.runDue(new Date("2026-08-30T02:00:00.000Z"))).resolves.toMatchObject({
      skipped_empty: 1, due_windows: 1,
    });
    expect(calls).toBe(0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function dispatcher(
  run: ReminderNotificationDispatcher["dispatch"],
): ReminderNotificationDispatcher {
  return { dispatch: run };
}

function result(
  status: NotificationDispatchResult["status"],
  id: string,
): NotificationDispatchResult {
  return {
    envelope_id: id,
    idempotency_key: id,
    status,
    deliveries: status === "completed" ? [{
      target_id: "memo", channel: "ntfy", status: "completed", evidence: "accepted",
    }] : [{
      target_id: "memo", channel: "ntfy", status: status === "uncertain" ? "uncertain" : "failed",
    }],
  };
}
