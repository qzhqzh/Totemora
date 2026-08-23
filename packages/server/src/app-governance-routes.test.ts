import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createPlaygroundApp } from "./app";

test("protects development policy mutations with the operator token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-operator-test-"));
  const protectedPath = join(dataDir, "protected");
  await mkdir(protectedPath);
  const app = createApp(dataDir);
  const deniedWorkplace = await app.fetch(new Request("http://local/api/workplaces", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Protected", path: protectedPath }),
  }));
  expect(deniedWorkplace.status).toBe(401);
  const workplace = await (await app.fetch(new Request("http://local/api/workplaces", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ name: "Protected", path: protectedPath }),
  }))).json();
  const body = JSON.stringify({
    instructions: "按规范提交", validation_commands: ["bun test"],
    allowed_commit_types: ["feat"], forbidden_paths: [".env"],
  });
  const denied = await app.fetch(new Request(`http://local/api/workplaces/${workplace.id}/policy`, {
    method: "PUT", headers: { "content-type": "application/json" }, body,
  }));
  expect(denied.status).toBe(401);
  expect((await denied.json()).error).toContain("authorization failed");
  const allowed = await app.fetch(new Request(`http://local/api/workplaces/${workplace.id}/policy`, {
    method: "PUT", headers: authorized(), body,
  }));
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({ version: 1, instructions: "按规范提交" });

  const preferencesBody = JSON.stringify({
    interests: ["AI Agent", "生物信息"],
    channels: { rss: true, ai_hot: true, x_trends: false, weibo_hot: false },
    x_woeid: 1,
  });
  expect((await app.fetch(new Request("http://local/api/intelligence/preferences", {
    method: "PUT", headers: { "content-type": "application/json" }, body: preferencesBody,
  }))).status).toBe(401);
  const savedPreferences = await app.fetch(new Request("http://local/api/intelligence/preferences", {
    method: "PUT", headers: authorized(), body: preferencesBody,
  }));
  expect(await savedPreferences.json()).toMatchObject({
    interests: ["AI Agent", "生物信息"], channels: { rss: true, ai_hot: true },
  });

  const taskBody = JSON.stringify({ workplace_id: workplace.id, goal: "按规范提交当前改动" });
  expect((await app.fetch(new Request("http://local/api/development/tasks", {
    method: "POST", headers: { "content-type": "application/json" }, body: taskBody,
  }))).status).toBe(401);
  expect((await app.fetch(new Request("http://local/api/development/tasks", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ workplace_id: workplace.id, goal: "invalid", mode: "rewrite" }),
  }))).status).toBe(400);
  expect((await app.fetch(new Request("http://local/api/development/proposals/missing", {
    headers: authorized(),
  }))).status).toBe(404);

  const startedTask = await app.fetch(new Request("http://local/api/development/tasks", {
    method: "POST", headers: authorized(), body: taskBody,
  }));
  expect(startedTask.status).toBe(202);
  const taskId = (await startedTask.json()).id as string;
  expect(await waitForDevelopmentTask(app, taskId)).toMatchObject({
    kind: "git_flow", status: "failed", retryable: true,
  });

  const restored = await createApp(dataDir).fetch(new Request(
    `http://local/api/development/tasks/${taskId}`,
    { headers: authorized() },
  ));
  expect(await restored.json()).toMatchObject({ id: taskId, status: "failed" });
  await rm(dataDir, { recursive: true, force: true });
});

function createApp(dataDir: string) {
  return createPlaygroundApp({
    configDir: resolve(import.meta.dir, "../../../configs/example"), dataDir,
    operatorToken: "operator-secret",
    createProviderRegistry: () => ({
      get: () => ({ async generate() { throw new Error("Provider call is not expected"); } }),
    }),
  });
}

function authorized(): Record<string, string> {
  return { "content-type": "application/json", authorization: "Bearer operator-secret" };
}

async function waitForDevelopmentTask(app: ReturnType<typeof createPlaygroundApp>, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await (await app.fetch(new Request(`http://local/api/development/tasks/${id}`, {
      headers: authorized(),
    }))).json();
    if (["completed", "failed"].includes(task.status)) return task;
    await Bun.sleep(5);
  }
  throw new Error("Development task did not finish");
}
