import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig } from "@totemora/core";
import { MemberProfileStore } from "./member-profile-store";
import { MemberStateStore } from "./member-state-store";

test("member portrait keeps constitution separate from observed evidence and reviewed revisions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-member-profile-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const member = config.agents.agents.find((item) => item.id === "qwen_intelligence")!;
  const store = new MemberProfileStore(dataDir);
  const initial = await store.current(member);
  expect(initial).toMatchObject({ version: 1, traits: expect.arrayContaining([expect.stringContaining("克制")]) });
  const proposal = await store.createProposal({
    member_id: member.id, base_version: 1, proposed_by: "deepseek_reasoner",
    proposed_changes: { working_preferences: [...initial.working_preferences, "重大更新优先解释新增事实"] },
    evidence_ids: ["evidence-1"], rationale: "重复情报需要更严格的新事实判断",
    expected_benefit: "减少重复打扰", risks: ["可能漏掉弱信号"],
  }, new Set(["evidence-1"]));
  expect((await store.current(member)).version).toBe(1);
  await expect(store.review(member, proposal.id, member.id, true)).rejects.toThrow("cannot review");
  const approved = await store.review(member, proposal.id, "deepseek_reasoner", true);
  expect(approved.constitution).toMatchObject({ version: 2, approved_by: "deepseek_reasoner" });
  await rm(dataDir, { recursive: true, force: true });
});

test("growth review remains eligible after the threshold instead of disappearing at run eleven", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-member-growth-threshold-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const state = new MemberStateStore(dataDir, config);
  for (let index = 0; index < 11; index += 1) await state.remember({
    member_id: "qwen_intelligence", kind: "success", summary: `成功 ${index + 1}`, verified: true, source_id: `run-${index + 1}`,
  });
  const dossier = await state.getDossier("qwen_intelligence");
  expect(dossier.growth).toMatchObject({ verified_successes: 11, eligible_growth_proposal: true, next_review_after_runs: 0 });
  await rm(dataDir, { recursive: true, force: true });
});

test("member success rate counts accepted outcomes instead of fractional experience credit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-member-outcome-rate-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const state = new MemberStateStore(dataDir, config);
  await state.remember({
    member_id: "qwen_intelligence", kind: "success", verified: true,
    source_type: "candidate_feedback", source_id: "opened-1",
    credit_type: "user_feedback", credit_value: 0.2, summary: "用户打开一条情报",
  });
  await state.remember({
    member_id: "qwen_intelligence", kind: "failure", verified: true,
    source_type: "runtime", source_id: "invalid-1", summary: "成员输出未通过事实门禁",
  });
  await state.remember({
    member_id: "qwen_intelligence", kind: "system_failure", verified: true,
    source_type: "runtime", source_id: "timeout-1", summary: "Provider timeout",
  });

  const dossier = await state.getDossier("qwen_intelligence");
  expect(dossier.portrait.task_record).toMatchObject({
    completed: 2, accepted: 1, experience_credit: 0.2,
    member_failures: 1, system_failures: 1, success_rate: 0.5,
  });
  expect(dossier.portrait.observed_traits.find((item) => item.name === "系统故障隔离")).toMatchObject({
    score: 1, evidence: "1 次系统故障独立记录，未计入成员失败",
  });
  await rm(dataDir, { recursive: true, force: true });
});
