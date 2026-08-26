import { expect, test } from "bun:test";

import { HttpError } from "./http-boundary";
import { handleOperationsRoutes } from "./operations-routes";

test("operations routes protect all evidence and bound list input", async () => {
  const limits: number[] = [];
  const handle = (request: Request) => handleOperationsRoutes(request, new URL(request.url), {
    recurringServiceStatus: () => [{ id: "intelligence.watch", running: false }],
    listTasks(limit) { limits.push(limit); return [{ id: "task-1" }]; },
    getTask(id) { return id === "task-1" ? { id } : undefined; },
    async listActions() { return [{ id: "action-1" }, { id: "action-2" }]; },
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw new HttpError(401, "Operator authorization failed");
      }
    },
  });

  expect(await handle(new Request("http://local/api/status"))).toBeUndefined();
  await expect(handle(new Request("http://local/api/service-tasks")))
    .rejects.toMatchObject({ status: 401 });
  await expect(handle(new Request("http://local/api/service-tasks?limit=all", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toMatchObject({ status: 400 });

  const tasks = await handle(new Request("http://local/api/service-tasks?limit=500", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await tasks?.json()).toEqual({ tasks: [{ id: "task-1" }] });
  expect(limits).toEqual([200]);

  const task = await handle(new Request("http://local/api/service-tasks/task-1", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await task?.json()).toEqual({ id: "task-1" });
  const missing = await handle(new Request("http://local/api/service-tasks/missing", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(missing?.status).toBe(404);

  const session = await handle(new Request("http://local/api/operator/session", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await session?.json()).toEqual({ authenticated: true });
  const actions = await handle(new Request("http://local/api/actions", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await actions?.json()).toEqual({ actions: [{ id: "action-2" }, { id: "action-1" }] });
});
