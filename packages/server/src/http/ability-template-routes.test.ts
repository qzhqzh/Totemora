import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AbilityTemplateStore } from "../ability-template-store";
import { handleAbilityTemplateRoutes } from "./ability-template-routes";
import { HttpError } from "./http-boundary";

test("ability template routes expose defaults and protect validated mutations", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ability-routes-"));
  const store = new AbilityTemplateStore(dataDir);
  const handle = (request: Request) => handleAbilityTemplateRoutes(request, new URL(request.url), {
    store,
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw new HttpError(401, "Operator authorization failed");
      }
    },
  });
  try {
    const listed = await handle(new Request("http://local/api/ability-templates"));
    expect(listed?.status).toBe(200);
    expect((await listed?.json()).prompts).toHaveLength(5);

    await expect(handle(new Request("http://local/api/ability-templates/prompt/chief-task-router", {
      method: "PUT", body: "{}",
    }))).rejects.toMatchObject({ status: 401 });

    const invalid = handle(new Request("http://local/api/ability-templates/workflow/git-flow-pipeline", {
      method: "PUT",
      headers: { authorization: "Bearer operator" },
      body: JSON.stringify({ name: "Invalid", trigger: "manual", summary: "No steps", steps: [] }),
    }));
    await expect(invalid).rejects.toMatchObject({ status: 400 });

    const updated = await handle(new Request("http://local/api/ability-templates/prompt/chief-task-router", {
      method: "PUT",
      headers: { authorization: "Bearer operator" },
      body: JSON.stringify({
        name: "首领路由 v2", category: "task", role: "chief", model: "deepseek/deepseek-v4-pro",
        summary: "正式定义", variables: ["goal"], content: "从 Gateway 读取。",
      }),
    }));
    expect(await updated?.json()).toMatchObject({ revision: 2, name: "首领路由 v2" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ability template routes bound JSON bodies before parsing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ability-body-"));
  try {
    const request = new Request("http://local/api/ability-templates/prompt/chief-task-router", {
      method: "PUT",
      headers: { authorization: "Bearer operator" },
      body: JSON.stringify({ content: "x".repeat(70_000) }),
    });
    await expect(handleAbilityTemplateRoutes(request, new URL(request.url), {
      store: new AbilityTemplateStore(dataDir),
      requireOperator() {},
    })).rejects.toMatchObject({ status: 413 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
