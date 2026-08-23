import { expect, test } from "bun:test";

import { HttpError } from "./http-boundary";
import {
  handleIntelligenceRoutes,
  type IntelligenceRouteService,
  type IntelligenceTaskView,
} from "./intelligence-routes";

test("intelligence routes keep reads public and tasks operator-gated", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);

  expect(await handle(new Request("http://local/api/status"))).toBeUndefined();
  const listed = await handle(new Request("http://local/api/intelligence"));
  expect(await listed?.json()).toEqual({ briefs: [{ id: "brief-1" }] });
  const preferences = await handle(new Request("http://local/api/intelligence/preferences"));
  expect(await preferences?.json()).toMatchObject({ credentials: { x_trends: true, weibo_hot: false } });

  await expect(handle(new Request("http://local/api/intelligence/tasks", {
    method: "POST", body: JSON.stringify({ message_count: 2 }),
  }))).rejects.toMatchObject({ status: 401 });
  const task = await handle(new Request("http://local/api/intelligence/tasks", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ message_count: 2, delivery_mode: "candidate_pool", idempotency_key: "scan-1" }),
  }));
  expect(task?.status).toBe(202);
  expect(calls).toContainEqual(["enqueue", {
    domain: "ai", message_count: 2, delivery_mode: "candidate_pool",
    idempotency_key: "scan-1",
  }]);

  expect((await handle(new Request("http://local/api/intelligence/tasks/ai", {
    headers: { authorization: "Bearer operator" },
  })))?.status).toBe(200);
  expect((await handle(new Request("http://local/api/intelligence/tasks/finance", {
    headers: { authorization: "Bearer operator" },
  })))?.status).toBe(404);
});

test("intelligence routes reject malformed preferences, task input, and feedback", async () => {
  const handle = routeHandler([]);
  await expect(handle(new Request("http://local/api/intelligence/tasks", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ message_count: 6 }),
  }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/intelligence/preferences", {
    method: "PUT", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ channels: { rss: "yes" } }),
  }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/intelligence/bark?health=full", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/intelligence/candidates/missing/feedback", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ signal: "valuable" }),
  }))).rejects.toMatchObject({ status: 404 });
});

test("Telegram webhook validates authorization and nested update fields", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);
  const request = (secret: string, body: unknown) => new Request("http://local/api/integrations/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(body),
  });

  await expect(handle(request("wrong", { update_id: 1 }))).rejects.toMatchObject({ status: 401 });
  await expect(handle(request("webhook", {
    update_id: 1, message: { message_id: 2, chat: { id: -100 } },
  }))).rejects.toMatchObject({ status: 400 });
  const response = await handle(request("webhook", {
    update_id: 1, message: { message_id: 2, text: "/help", chat: { id: -100, type: "group" } },
  }));
  expect(response?.status).toBe(200);
  expect(calls.some((call) => call[0] === "telegram" && (call[1] as any).update_id === 1)).toBe(true);
});

function routeHandler(calls: unknown[][]) {
  const service = intelligenceService(calls);
  const tasks: Record<string, IntelligenceTaskView> = {
    ai: { domain: "ai" }, finance: { domain: "finance" },
  };
  return (request: Request) => handleIntelligenceRoutes(request, new URL(request.url), {
    async getIntelligence() { return service; },
    preferences: {
      async get() { return { interests: [] } as any; },
      async save(input) { calls.push(["preferences", input]); return input as any; },
    },
    async credentialStatus() { return { x_trends: true, weibo_hot: false }; },
    async enqueueTask(input) { calls.push(["enqueue", input]); return { id: "task-1", domain: "ai" }; },
    getTask(id) { return tasks[id]; },
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") throw new HttpError(401, "unauthorized");
    },
  });
}

function intelligenceService(calls: unknown[][]): IntelligenceRouteService {
  return {
    async list() { return [{ id: "brief-1" }] as any; },
    async listCandidates() { return [] as any; },
    async candidateCounts() { return {} as any; },
    async barkStatus(health) { return { health } as any; },
    async telegramStatus(health) { return { health } as any; },
    async verifyTelegramWebhook(secret) { if (secret !== "webhook") throw new Error("bad secret"); },
    async handleTelegramUpdate(update) {
      calls.push(["telegram", update]);
      return { accepted: true, replayed: false };
    },
    async recordFeedback(id) {
      if (id === "missing") throw new Error(`Intelligence candidate not found: ${id}`);
      return { inserted: true } as any;
    },
    async openFeedback() { return undefined; },
    async run(input) { calls.push(["run", input]); return { id: "brief-1" } as any; },
  };
}
