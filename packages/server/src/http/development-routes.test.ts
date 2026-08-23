import { expect, test } from "bun:test";

import { HttpError } from "./http-boundary";
import {
  handleDevelopmentRoutes,
  type DevelopmentRouteService,
  type DevelopmentTaskView,
} from "./development-routes";

test("development routes protect mutations and validate task input", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);
  expect(await handle(new Request("http://local/api/status"))).toBeUndefined();
  await expect(handle(new Request("http://local/api/development/tasks", {
    method: "POST", body: JSON.stringify({ workplace_id: "work-1", goal: "prepare" }),
  }))).rejects.toMatchObject({ status: 401 });
  await expect(handle(new Request("http://local/api/development/tasks", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ workplace_id: "work-1", goal: "prepare", mode: "rewrite" }),
  }))).rejects.toMatchObject({ status: 400 });

  const created = await handle(new Request("http://local/api/development/tasks", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({
      workplace_id: "work-1", goal: "  prepare release  ", mode: "merge",
      issue_mode: "auto", trial_commission_id: "trial-1",
    }),
  }));
  expect(created?.status).toBe(202);
  expect(calls).toContainEqual(["enqueue", {
    workplace_id: "work-1", goal: "prepare release", mode: "merge",
    issue_mode: "auto", trial_commission_id: "trial-1",
  }]);
});

test("development routes sort task history and translate missing resources", async () => {
  const handle = routeHandler([]);
  const listed = await handle(new Request("http://local/api/development/tasks", {
    headers: { authorization: "Bearer operator" },
  }));
  const tasks = (await listed?.json()).tasks as Array<{ id: string }>;
  expect(tasks.map((task) => task.id)).toEqual(["new", "old"]);

  const missingTask = await handle(new Request("http://local/api/development/tasks/missing", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(missingTask?.status).toBe(404);
  await expect(handle(new Request("http://local/api/development/proposals/missing", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toMatchObject({ status: 404 });
  await expect(handle(new Request("http://local/api/development/skill-proposals/missing/approve", {
    method: "POST", headers: { authorization: "Bearer operator" },
  }))).rejects.toMatchObject({ status: 404 });
});

test("development advance validates gates, maps conflicts, and synchronizes proposals", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);
  const advance = (id: string, gate: string) => handle(new Request(
    `http://local/api/development/proposals/${id}/advance`, {
      method: "POST", headers: { authorization: "Bearer operator" },
      body: JSON.stringify({ gate }),
    },
  ));

  await expect(advance("proposal-1", "deploy")).rejects.toMatchObject({ status: 400 });
  for (const gate of ["local", "remote", "merge"] as const) {
    const response = await advance("proposal-1", gate);
    expect(response?.status).toBe(200);
  }
  expect(calls.filter((call) => call[0] === "sync")).toHaveLength(3);
  await expect(advance("conflict", "local")).rejects.toMatchObject({ status: 409 });
});

function routeHandler(calls: unknown[][]) {
  const service = developmentService(calls);
  const tasks: Array<DevelopmentTaskView & { id: string }> = [
    { id: "old", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "new", created_at: "2026-02-01T00:00:00.000Z" },
  ];
  return (request: Request) => handleDevelopmentRoutes(request, new URL(request.url), {
    async getDevelopment() { return service; },
    async enqueueTask(input) { calls.push(["enqueue", input]); return { id: "task-1" }; },
    listTasks() { return [...tasks]; },
    getTask(id) { return tasks.find((task) => task.id === id); },
    syncSpecialistTask(proposal) { calls.push(["sync", proposal.status]); },
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") throw new HttpError(401, "unauthorized");
    },
  });
}

function developmentService(calls: unknown[][]): DevelopmentRouteService {
  const proposal = (status: string) => ({ id: "proposal-1", status }) as any;
  return {
    async prepare(_workplaceId, _goal, options) { calls.push(["prepare", options]); return proposal("awaiting_approval"); },
    async listProposals() { return [proposal("awaiting_approval")]; },
    async listSkillProposals() { return [] as any; },
    async approveSkillProposal(id) {
      if (id === "missing") throw new Error(`Skill proposal not found: ${id}`);
      return { id } as any;
    },
    async getProposal(id) {
      if (id === "missing") throw new Error(`Development proposal not found: ${id}`);
      return proposal("awaiting_approval");
    },
    async approve(id) {
      if (id === "conflict") throw new Error("Proposal cannot execute from status completed");
      calls.push(["advance", "local"]); return proposal("awaiting_remote_approval");
    },
    async publish() { calls.push(["advance", "remote"]); return proposal("awaiting_merge_approval"); },
    async merge() { calls.push(["advance", "merge"]); return proposal("completed"); },
  };
}
