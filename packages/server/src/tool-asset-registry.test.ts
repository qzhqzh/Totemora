import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadLocalConfig } from "@totemora/core";
import { ToolAssetRegistry } from "./tool-asset-registry";

test("lists shared tribe assets and enforces member grants", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-assets-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const registry = new ToolAssetRegistry(resolve(import.meta.dir, "../../.."), dataDir);
  const assets = await registry.list(config);
  expect(assets.find((asset) => asset.id === "git-flow-engine")).toMatchObject({
    maturity: "verified",
    authorized_members: [{ id: "deepseek_git_steward" }],
  });
  const steward = config.agents.agents.find((member) => member.id === "deepseek_git_steward")!;
  const qwen = config.agents.agents.find((member) => member.id === "qwen_worker")!;
  await expect(registry.assertCanUse(steward, "git-flow-engine", "execute_local")).resolves.toMatchObject({ id: "git-flow-engine" });
  await expect(registry.assertCanUse(qwen, "git-flow-engine", "execute_local")).rejects.toThrow("not authorized");
  await expect(registry.assertCanUse(steward, "zvec", "search")).rejects.toThrow("not executable");
  await registry.recordUse({
    asset_id: "git-flow-engine", member_id: steward.id, workflow_id: "workflow-1",
    action: "execute_local", outcome: "completed", evidence: "commit abc",
  });
  expect((await registry.list(config)).find((asset) => asset.id === "git-flow-engine")?.usage_count).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});
