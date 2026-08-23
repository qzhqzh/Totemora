import { expect, test } from "bun:test";

import { HttpError } from "./http-boundary";
import { handleWorkplaceRoutes } from "./workplace-routes";

test("workplace routes keep settlement public and protect bounded mutations", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);

  expect(await handle(new Request("http://local/api/status"))).toBeUndefined();
  expect(await (await handle(new Request("http://local/api/settlement")))?.json()).toEqual({ workplaces: [] });
  await expect(handle(new Request("http://local/api/workplaces", {
    method: "POST", body: JSON.stringify({ name: "Demo", path: "/workspace" }),
  }))).rejects.toMatchObject({ status: 401 });
  await expect(handle(new Request("http://local/api/workplaces", {
    method: "POST", headers: authorized(), body: JSON.stringify({ name: "", path: "/workspace" }),
  }))).rejects.toMatchObject({ status: 400 });

  const created = await handle(new Request("http://local/api/workplaces", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ name: "  Demo  ", path: "  /workspace  " }),
  }));
  expect(created?.status).toBe(201);
  expect(calls).toContainEqual(["add", "Demo", "/workspace"]);
  await expect(handle(new Request("http://local/api/workplaces", {
    method: "POST", headers: authorized(), body: JSON.stringify({ name: "Duplicate", path: "/duplicate" }),
  }))).rejects.toMatchObject({ status: 409 });
});

test("workplace policy validates nested fields and maps missing resources", async () => {
  const calls: unknown[][] = [];
  const handle = routeHandler(calls);
  const policy = {
    instructions: "follow policy",
    validation_commands: ["bun test"],
    allowed_commit_types: ["feat"],
    forbidden_paths: [".env"],
    git_flow: {
      remote_provider: "github", target_branch: "main", allow_issue: true,
      allow_push: false, allow_pull_request: true, allow_merge: false, allow_opencode_fix: false,
    },
  };

  await expect(handle(new Request("http://local/api/workplaces/work-1/policy", {
    method: "PUT", headers: authorized(),
    body: JSON.stringify({ ...policy, git_flow: { ...policy.git_flow, allow_push: "yes" } }),
  }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/workplaces/missing/policy", {
    method: "PUT", headers: authorized(), body: JSON.stringify(policy),
  }))).rejects.toMatchObject({ status: 404 });

  const saved = await handle(new Request("http://local/api/workplaces/work-1/policy", {
    method: "PUT", headers: authorized(), body: JSON.stringify(policy),
  }));
  expect(saved?.status).toBe(200);
  expect(calls).toContainEqual(["policy", "work-1", policy]);
});

function routeHandler(calls: unknown[][]) {
  return (request: Request) => handleWorkplaceRoutes(request, new URL(request.url), {
    async getSettlement() { return { workplaces: [] }; },
    async addWorkplace(name, path) {
      if (path === "/duplicate") throw new Error("这个路径已经登记为工作地");
      calls.push(["add", name, path]);
      return { id: "work-1" };
    },
    async setWorkplacePolicy(id, input) {
      if (id === "missing") throw new Error("工作地不存在");
      calls.push(["policy", id, input]);
      return input;
    },
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
