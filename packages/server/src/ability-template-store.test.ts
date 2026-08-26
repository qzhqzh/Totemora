import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AbilityTemplateInputError,
  AbilityTemplateNotFoundError,
  AbilityTemplateStore,
} from "./ability-template-store";

test("ability templates keep defaults in code and persist governed overrides in SQLite", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ability-templates-"));
  try {
    const store = new AbilityTemplateStore(dataDir);
    const defaults = store.list();
    expect(defaults.prompts).toHaveLength(5);
    expect(defaults.workflows).toHaveLength(3);

    const updated = store.update("prompt", "chief-task-router", {
      name: "首领路由 v2",
      category: "task",
      role: "chief",
      model: "deepseek/deepseek-v4-pro",
      summary: "使用持久治理定义。",
      variables: ["goal"],
      content: "只根据 Gateway 中的正式定义完成派工。",
    });
    expect(updated).toMatchObject({ id: "chief-task-router", revision: 2, name: "首领路由 v2" });
    expect(new AbilityTemplateStore(dataDir).list().prompts.find((item) => item.id === updated.id))
      .toEqual(updated);

    store.delete("workflow", "git-flow-pipeline");
    expect(new AbilityTemplateStore(dataDir).list().workflows.map((item) => item.id))
      .not.toContain("git-flow-pipeline");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("ability templates reject malformed definitions and missing records", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ability-validation-"));
  try {
    const store = new AbilityTemplateStore(dataDir);
    expect(() => store.update("workflow", "git-flow-pipeline", {
      name: "Invalid",
      trigger: "manual",
      summary: "missing steps",
      steps: [],
    })).toThrow(AbilityTemplateInputError);
    expect(() => store.delete("prompt", "missing-template"))
      .toThrow(AbilityTemplateNotFoundError);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
