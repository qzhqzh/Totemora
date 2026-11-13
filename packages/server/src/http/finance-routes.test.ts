import { expect, test } from "bun:test";

import { HttpError } from "./http-boundary";
import { handleFinanceRoutes, type FinanceRouteService } from "./finance-routes";
import type { IntelligenceTaskView } from "./intelligence-routes";

test("finance routes expose public evidence and isolate finance tasks", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);
  expect(await handle(new Request("http://local/api/status"))).toBeUndefined();
  expect(await (await handle(new Request("http://local/api/finance/sources")))?.json())
    .toEqual({ sources: [{ id: "source-1" }] });

  const created = await handle(new Request("http://local/api/finance/tasks", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({
      message_count: 1, delivery_mode: "direct_push",
      briefing_type: "asia_preopen", idempotency_key: "finance-1",
    }),
  }));
  expect(created?.status).toBe(202);
  expect(calls).toContainEqual(["enqueue", {
    domain: "finance", message_count: 1, delivery_mode: "direct_push",
    briefing_type: "asia_preopen", idempotency_key: "finance-1",
  }]);
  expect((await handle(new Request("http://local/api/finance/tasks/finance", {
    headers: { authorization: "Bearer operator" },
  })))?.status).toBe(200);
  expect((await handle(new Request("http://local/api/finance/tasks/ai", {
    headers: { authorization: "Bearer operator" },
  })))?.status).toBe(404);
});

test("finance brief list validates explicit limits without changing the unlimited endpoint", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);
  for (const [query, limit] of [["", undefined], ["?limit=1", 1], ["?limit=4", 4], ["?limit=100", 100]] as const) {
    const response = await handle(new Request(`http://local/api/finance${query}`));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ briefs: [] });
    expect(calls.at(-1)).toEqual(["list", limit]);
  }
  calls.length = 0;
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=", "limit=4&limit=4"]) {
    await expect(handle(new Request(`http://local/api/finance?${query}`))).rejects.toMatchObject({ status: 400 });
  }
  expect(calls).toEqual([]);
});

test("finance routes reject invalid markets, watchlist, briefing, and health input", async () => {
  const handle = routeHandler([]);
  const authorizedPut = (body: unknown) => new Request("http://local/api/finance/preferences", {
    method: "PUT", headers: { authorization: "Bearer operator" }, body: JSON.stringify(body),
  });
  await expect(handle(authorizedPut({ markets: [] }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(authorizedPut({ watchlist: [{ market: "US", symbol: "../AAPL" }] })))
    .rejects.toMatchObject({ status: 400 });
  await expect(handle(authorizedPut({
    morning_briefings: { asia_preopen: { enabled: true, time: "25:00" } },
  }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/finance/tasks", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ briefing_type: "closing_bell" }),
  }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/finance/bark?health=yes", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toMatchObject({ status: 400 });
});

function routeHandler(calls: unknown[][]) {
  const service = financeService(calls);
  const tasks: Record<string, IntelligenceTaskView> = {
    ai: { domain: "ai" }, finance: { domain: "finance" },
  };
  return (request: Request) => handleFinanceRoutes(request, new URL(request.url), {
    async getFinance() { return service; },
    preferences: {
      async get() { return { markets: ["CN"] } as any; },
      async save(input) { calls.push(["preferences", input]); return input as any; },
    },
    async enqueueTask(input) { calls.push(["enqueue", input]); return { id: "task-1", domain: "finance" }; },
    getTask(id) { return tasks[id]; },
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") throw new HttpError(401, "unauthorized");
    },
  });
}

function financeService(calls: unknown[][]): FinanceRouteService {
  return {
    async list(limit) { calls.push(["list", limit]); return [] as any; },
    async listCandidates() { return [] as any; },
    async candidateCounts() { return {} as any; },
    async sourceStatus() { return [{ id: "source-1" }] as any; },
    async barkStatus(health) { return { health } as any; },
    async run() { return { id: "brief-1" } as any; },
  };
}
