import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig, type AgentProvider } from "@totemora/core";
import { MemberEvolutionService } from "./member-evolution-service";
import { MemberStateStore, type MemberMemoryEvent } from "./member-state-store";

test("mentor proposes evidence-bound personality growth and operator review applies a new version", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-member-evolution-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const state = new MemberStateStore(dataDir, config);
  const evidence: MemberMemoryEvent[] = [];
  for (let index = 0; index < 10; index += 1) evidence.push(await state.remember({
    member_id: "qwen_intelligence", kind: "success", summary: `去重情报成功 ${index + 1}`, verified: true, source_id: `scan-${index + 1}`,
  }));
  let generations = 0;
  const provider: AgentProvider = { async generate(request) {
    generations += 1;
    expect(request.memberId).toBe("deepseek_reasoner");
    if (generations === 1) return { content: "需要更克制，但暂时不提供结构化证据。" };
    expect(request.messages.at(-1)?.content).toContain("上次结果未通过");
    return { content: JSON.stringify({
      proposed_changes: { working_preferences: ["同一事件只有出现新事实才再次推送"] },
      evidence_ids: [evidence[0]!.id], rationale: "已经形成稳定去重经验",
      expected_benefit: "减少重复打扰", risks: ["可能漏掉措辞变化"],
    }) };
  } };
  const service = new MemberEvolutionService(config, { get: () => provider }, state);
  const proposal = await service.propose("qwen_intelligence");
  expect(generations).toBe(2);
  expect(proposal).toMatchObject({ status: "pending", proposed_by: "deepseek_reasoner", base_version: 1 });
  expect((await state.getDossier("qwen_intelligence")).portrait.constitution.version).toBe(1);
  await service.review("qwen_intelligence", proposal.id, "deepseek_reasoner", true);
  expect((await state.getDossier("qwen_intelligence")).portrait.constitution).toMatchObject({ version: 2, working_preferences: ["同一事件只有出现新事实才再次推送"] });
  await rm(dataDir, { recursive: true, force: true });
});

test("automatic growth review stays dormant until enough verified experience exists", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-member-evolution-dormant-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const state = new MemberStateStore(dataDir, config);
  let generations = 0;
  const provider: AgentProvider = { async generate() { generations += 1; return { content: "{}" }; } };
  const service = new MemberEvolutionService(config, { get: () => provider }, state);
  expect(await service.proposeIfEligible("qwen_intelligence")).toBeUndefined();
  expect(generations).toBe(0);
  await rm(dataDir, { recursive: true, force: true });
});

test("normalizes a bounded alternate mentor proposal shape", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-member-evolution-normalize-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const state = new MemberStateStore(dataDir, config);
  const evidence: MemberMemoryEvent[] = [];
  for (let index = 0; index < 10; index += 1) evidence.push(await state.remember({
    member_id: "qwen_intelligence", kind: "success", summary: `完成 ${index + 1}`, verified: true,
  }));
  await state.remember({ member_id: "qwen_intelligence", kind: "system_failure", summary: "DO_NOT_USE_INFRASTRUCTURE_FAILURE", verified: true });
  const provider: AgentProvider = { async generate(request) {
    expect(request.messages.at(-1)?.content).not.toContain("DO_NOT_USE_INFRASTRUCTURE_FAILURE");
    return { content: JSON.stringify({ proposal: {
    changes: { traits: ["更善于识别重复事件"] }, evidence: [{ id: evidence[0]!.id }], reason: "重复抑制已形成经验",
  } }) }; } };
  const proposal = await new MemberEvolutionService(config, { get: () => provider }, state).propose("qwen_intelligence");
  expect(proposal).toMatchObject({ proposed_changes: { traits: ["更善于识别重复事件"] }, risks: [expect.stringContaining("过拟合")] });
  await rm(dataDir, { recursive: true, force: true });
});
