import { expect, test } from "bun:test";

import type { ReminderItem } from "../domains/reminder/reminder";
import { HttpError } from "./http-boundary";
import { handleReminderRoutes, type ReminderRouteService } from "./reminder-routes";

test("reminder routes are operator-only and validate bounded create inputs", async () => {
  const calls: unknown[] = [];
  const service = fakeService({
    create(input) { calls.push(input); return reminder(); },
  });
  await expect(handle(new Request("http://local/api/reminders"), service))
    .rejects.toMatchObject({ status: 401 });
  const response = await handle(new Request("http://local/api/reminders", {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify({ title: "Release", deadline_local_date: "2026-09-01", importance: 3 }),
  }), service);
  expect(response?.status).toBe(201);
  expect(calls).toEqual([{ title: "Release", deadline_local_date: "2026-09-01", importance: 3 }]);

  await expect(handle(new Request("http://local/api/reminders", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ title: "Bad", deadline_local_date: "2026-02-30", importance: 2 }),
  }), service)).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/reminders", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ title: "Bad", deadline_local_date: "2026-09-01", importance: 3, secret: "x" }),
  }), service)).rejects.toMatchObject({ status: 400 });
});

test("lists by explicit status and maps lifecycle actions without deletion", async () => {
  const calls: unknown[] = [];
  const service = fakeService({
    list(status) { calls.push({ status }); return [reminder()]; },
    complete(id) { calls.push({ complete: id }); return { ...reminder(), status: "completed" }; },
    reopen(id) { calls.push({ reopen: id }); return reminder(); },
  });
  const listed = await handle(new Request("http://local/api/reminders?status=all", {
    headers: authorized(),
  }), service);
  expect(await listed?.json()).toMatchObject({ status: "all", reminders: [{ id: "r-1" }] });
  await handle(new Request("http://local/api/reminders/r-1/complete", {
    method: "POST", headers: authorized(),
  }), service);
  await handle(new Request("http://local/api/reminders/r-1/reopen", {
    method: "POST", headers: authorized(),
  }), service);
  expect(calls).toEqual([{ status: "all" }, { complete: "r-1" }, { reopen: "r-1" }]);
  await expect(handle(new Request("http://local/api/reminders?status=future", {
    headers: authorized(),
  }), service)).rejects.toMatchObject({ status: 400 });
});

function handle(request: Request, service: ReminderRouteService) {
  return handleReminderRoutes(request, new URL(request.url), {
    service,
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw new HttpError(401, "unauthorized");
      }
    },
  });
}

function fakeService(overrides: Partial<ReminderRouteService>): ReminderRouteService {
  return {
    list: () => [],
    create: () => reminder(),
    complete: () => ({ ...reminder(), status: "completed" }),
    reopen: () => reminder(),
    ...overrides,
  };
}

function reminder(): ReminderItem {
  return {
    id: "r-1", title: "Release", deadline_local_date: "2026-09-01", importance: 3,
    status: "active", created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z",
  };
}

function authorized(): HeadersInit {
  return { authorization: "Bearer operator", "content-type": "application/json" };
}
