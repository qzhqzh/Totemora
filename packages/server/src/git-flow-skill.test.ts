import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GIT_FLOW_SKILL_ID, GIT_FLOW_SKILL_VERSION } from "./git-flow-skill";

test("Git Flow runtime identity matches the repository Skill manifest", async () => {
  const manifest = await readFile(resolve(
    import.meta.dir,
    "../../../skills",
    GIT_FLOW_SKILL_ID,
    "skill.yaml",
  ), "utf8");
  expect(manifest.match(/^id:\s*(.+)$/m)?.[1]).toBe(GIT_FLOW_SKILL_ID);
  expect(Number(manifest.match(/^version:\s*(\d+)$/m)?.[1])).toBe(GIT_FLOW_SKILL_VERSION);
});
