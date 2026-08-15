import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GIT_FLOW_SKILL_ID, GIT_FLOW_SKILL_VERSION } from "./git-flow-skill";
import { SkillGovernanceStore } from "./skill-governance-store";
import { StateDatabase } from "./state-database";

test("Git Flow v4 imports and rebases the legacy v3 active overlay", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-git-flow-overlay-"));
  const legacyDirectory = join(dataDir, "skills", "git-change-management");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(join(legacyDirectory, "active.json"), JSON.stringify({
    skill_id: "git-change-management",
    version: 4,
    additions: ["提交前确认验证命令没有改写批准文件"],
    updated_at: "2026-08-14T00:00:00.000Z",
  }));

  const store = new SkillGovernanceStore(dataDir, GIT_FLOW_SKILL_ID, GIT_FLOW_SKILL_VERSION);
  await expect(store.getActive("base instructions")).resolves.toMatchObject({
    version: 5,
    content: expect.stringContaining("提交前确认验证命令没有改写批准文件"),
  });
  expect(StateDatabase.open(dataDir).listRecords("skill_overlays")).toEqual([
    expect.objectContaining({
      skill_id: GIT_FLOW_SKILL_ID,
      base_version: GIT_FLOW_SKILL_VERSION,
      version: 5,
    }),
  ]);

  await rm(dataDir, { recursive: true, force: true });
});
