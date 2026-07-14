import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettlementStore } from "./settlement-store";

test("persists workplaces and mission requests across store instances", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-settlement-"));
  const store = new SettlementStore(dataDir);
  const workplace = await store.addWorkplace("Demo", "/tmp/demo");
  await store.setWorkplacePolicy(workplace.id, {
    instructions: "只提交当前目标相关改动",
    validation_commands: ["bun test"],
    allowed_commit_types: ["feat", "fix"],
    forbidden_paths: [".env"],
  });
  const mission = await store.createMission("检查折扣逻辑", workplace.id);
  await store.addRequest(mission.id, "先分析风险", "run-1");
  await store.completeRequest(mission.id, "run-1", { outcome: "completed", result_summary: "发现一个风险" });

  const restored = await new SettlementStore(dataDir).get();
  expect(restored.workplaces[0]).toMatchObject({ name: "Demo", path: "/tmp/demo", policy: { version: 1, validation_commands: ["bun test"] } });
  expect(restored.missions[0]?.requests[0]).toMatchObject({ text: "先分析风险", run_id: "run-1", outcome: "completed", result_summary: "发现一个风险" });
  await rm(dataDir, { recursive: true, force: true });
});
