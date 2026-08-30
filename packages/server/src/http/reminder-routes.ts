import type { ReminderItem } from "../domains/reminder/reminder";
import {
  REMINDER_STATUS_VALUES,
  assertLocalDate,
  assertReminderImportance,
  assertReminderTitle,
} from "../domains/reminder/reminder";
import { HttpError, json, readJson } from "./http-boundary";
import { inputObject } from "./input-schema";

export interface ReminderRouteService {
  list(status: "active" | "completed" | "expired" | "all"): ReminderItem[];
  create(input: { title: unknown; deadline_local_date: unknown; importance: unknown }): ReminderItem;
  complete(id: string): ReminderItem;
  reopen(id: string): ReminderItem;
}

export interface ReminderRouteDependencies {
  service: ReminderRouteService;
  requireOperator(request: Request): void;
}

export async function handleReminderRoutes(
  request: Request,
  url: URL,
  dependencies: ReminderRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/reminders")) return undefined;
  dependencies.requireOperator(request);
  try {
    if (request.method === "GET" && url.pathname === "/api/reminders") {
      const status = reminderStatus(url.searchParams.get("status"));
      return json({ reminders: dependencies.service.list(status), status });
    }
    if (request.method === "POST" && url.pathname === "/api/reminders") {
      const body = inputObject(await readJson(request, 4_000));
      rejectUnknown(body, ["title", "deadline_local_date", "importance"]);
      return json({ reminder: dependencies.service.create({
        title: assertReminderTitle(body.title),
        deadline_local_date: assertLocalDate(body.deadline_local_date),
        importance: assertReminderImportance(body.importance),
      }) }, 201);
    }
    const action = url.pathname.match(/^\/api\/reminders\/([^/]+)\/(complete|reopen)$/);
    if (request.method === "POST" && action) {
      const id = reminderId(action[1]!);
      return json({
        reminder: action[2] === "complete"
          ? dependencies.service.complete(id)
          : dependencies.service.reopen(id),
      });
    }
    return undefined;
  } catch (error) {
    throw translate(error);
  }
}

function reminderStatus(value: string | null): "active" | "completed" | "expired" | "all" {
  const status = value?.trim() || "active";
  if (status !== "all" && !REMINDER_STATUS_VALUES.includes(status as typeof REMINDER_STATUS_VALUES[number])) {
    throw new HttpError(400, "status must be active, completed, expired, or all");
  }
  return status as "active" | "completed" | "expired" | "all";
}

function reminderId(encoded: string): string {
  let value: string;
  try { value = decodeURIComponent(encoded); }
  catch { throw new HttpError(400, "Reminder id is not valid URL encoding"); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)) {
    throw new HttpError(400, "Reminder id is invalid");
  }
  return value;
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new HttpError(400, `Unsupported reminder field: ${unknown}`);
}

function translate(error: unknown): Error {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Reminder not found:")) return new HttpError(404, message);
  if (message.startsWith("Reminder ")) return new HttpError(400, message);
  return error instanceof Error ? error : new Error(message);
}
