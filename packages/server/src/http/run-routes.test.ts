import { expect, test } from "bun:test";

import { HttpError } from "./http-boundary";
import { handleRunRoutes, type RunJobView } from "./run-routes";

test("run routes keep observations public and protect mutations", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);

  expect(await handle(new Request("http://local/api/status"))).toBeUndefined();
  expect(await (await handle(new Request("http://local/api/runs")))?.json()).toEqual({
    runs: [{ id: "persisted-run" }],
  });
  expect(await (await handle(new Request("http://local/api/jobs")))?.json()).toEqual({
    jobs: [
      expect.objectContaining({ id: "new", goal: "completed goal" }),
      expect.objectContaining({ id: "old", goal: "queued goal" }),
    ],
  });

  await expect(handle(new Request("http://local/api/runs", {
    method: "POST", body: JSON.stringify({ goal: "inspect" }),
  }))).rejects.toMatchObject({ status: 401 });
  await expect(handle(new Request("http://local/api/missions", {
    method: "POST", headers: authorized(), body: JSON.stringify({ title: "" }),
  }))).rejects.toMatchObject({ status: 400 });

  const mission = await handle(new Request("http://local/api/missions", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ title: "  Mission one  ", workplace_id: "work-1" }),
  }));
  expect(mission?.status).toBe(201);
  expect(calls).toContainEqual(["mission", { title: "Mission one", workplace_id: "work-1" }]);
  await expect(handle(new Request("http://local/api/missions", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ title: "orphan", workplace_id: "missing" }),
  }))).rejects.toMatchObject({ status: 404 });
});

test("run and intake inputs are bounded before reaching application services", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);

  await expect(handle(new Request("http://local/api/intake/analyze", {
    method: "POST", body: JSON.stringify({ goal: "" }),
  }))).rejects.toMatchObject({ status: 400 });
  const analysis = await handle(new Request("http://local/api/intake/analyze", {
    method: "POST",
    body: JSON.stringify({ goal: "  inspect repo  ", workspace: "/workspace", mission_id: "mission-1" }),
  }));
  expect(await analysis?.json()).toEqual({ type: "inspect" });
  expect(calls).toContainEqual(["analyze", {
    goal: "inspect repo", has_workspace: true, continuing: true,
  }]);

  await expect(handle(new Request("http://local/api/runs", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ goal: "inspect", max_members: 0 }),
  }))).rejects.toMatchObject({ status: 400 });
  const started = await handle(new Request("http://local/api/runs", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({
      goal: "  inspect repo  ", workplace_id: "work-1", acceptance: ["cite README"],
      max_files: 80, max_context_bytes: 120_000, max_output_tokens: 6_000,
      max_members: 2, max_total_tokens: 24_000,
    }),
  }));
  expect(started?.status).toBe(202);
  expect(calls).toContainEqual(["enqueue", expect.objectContaining({
    goal: "inspect repo", workplace_id: "work-1", max_members: 2,
  })]);
});

test("run lifecycle routes decode ids and delegate state transitions", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);

  expect((await handle(new Request("http://local/api/runs/missing")))?.status).toBe(404);
  expect((await handle(new Request("http://local/api/runs/new")))?.status).toBe(200);
  await expect(handle(new Request("http://local/api/runs/new/cancel", {
    method: "POST",
  }))).rejects.toMatchObject({ status: 401 });

  const cancelled = await handle(new Request("http://local/api/runs/%6Eew/cancel", {
    method: "POST", headers: authorized(),
  }));
  const retried = await handle(new Request("http://local/api/runs/old/retry", {
    method: "POST", headers: authorized(),
  }));
  expect(cancelled?.status).toBe(202);
  expect(retried?.status).toBe(202);
  expect(calls).toContainEqual(["cancel", "new"]);
  expect(calls).toContainEqual(["retry", "old"]);

  await expect(handle(new Request("http://local/api/runs/%E0%A4%A")))
    .rejects.toMatchObject({ status: 400 });
});

function routeHandler(calls: unknown[][]) {
  const jobs: RunJobView[] = [
    {
      id: "old", status: "queued", phase: "queued", message: "waiting",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "new", status: "completed", phase: "completed", message: "done",
      created_at: "2026-02-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z",
      run: { task: { goal: "completed goal" } },
    },
  ];
  return (request: Request) => handleRunRoutes(request, new URL(request.url), {
    async createMission(input) {
      if (input.workplace_id === "missing") throw new Error("工作地不存在");
      calls.push(["mission", input]);
      return { id: "mission-1" };
    },
    analyzeTask(input) { calls.push(["analyze", input]); return { type: "inspect" }; },
    async enqueueRun(input) { calls.push(["enqueue", input]); return jobs[0]!; },
    async listPersistedRuns() { return [{ id: "persisted-run" }]; },
    listJobs() { return [...jobs]; },
    getJob(id) { return jobs.find((job) => job.id === id); },
    getJobGoal(id) { return id === "old" ? "queued goal" : undefined; },
    async cancelRun(id) { calls.push(["cancel", id]); return jobs[1]!; },
    async retryRun(id) { calls.push(["retry", id]); return jobs[0]!; },
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw new HttpError(401, "unauthorized");
      }
    },
  });
}

function authorized(): Record<string, string> {
  return { "content-type": "application/json", authorization: "Bearer operator" };
}
