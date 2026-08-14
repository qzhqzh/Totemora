import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig, type AgentProvider } from "@totemora/core";
import { SkillCommissionService } from "./skill-commission-service";
import { StateDatabase } from "./state-database";

test("conversation creates, validates, trials, activates and rolls back a governed Skill", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-commission-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let calls = 0;
  const provider: AgentProvider = { async generate() {
    calls += 1;
    if (calls === 1) return { content: JSON.stringify({
      ready: false,
      reply: "请补充至少两个验收例子，以及该能力应装备给谁。",
      title: "Git 提交范围治理", goal: "让 Git 专员更稳定地控制提交范围",
    }) };
    return { content: JSON.stringify({
      ready: true,
      reply: "已形成 Git 提交范围治理草案，等待静态校验。",
      title: "Git 提交范围治理",
      goal: "让执简在 Git Flow 任务中先核对用户授权范围，再形成提交计划。",
      skill_id: "git-change-management",
      target_member_id: "deepseek_git_steward",
      target_service_id: "git.flow",
      risk: "repository_mutation",
      trigger: "收到提交、PR 或合并委任时",
      instructions: ["先读取完整 git status 并列出拟纳入文件", "逐项比对用户目标和 Workplace Policy 后再规划 Commit"],
      boundaries: ["不得使用 git add .、force push 或绕过审批门禁"],
      acceptance_examples: ["仅纳入用户目标涉及的文件", "发现范围不明时停止并向 Chief 报告"],
      sources: ["https://example.com/git-guide"],
      requested_assets: ["git-flow-engine"],
    }) };
  } };
  const service = new SkillCommissionService(config, { get: () => provider }, dataDir);
  const discovering = await service.create("参考 https://example.com/git-guide，让执简学习更严格的提交范围控制。");
  expect(discovering).toMatchObject({ status: "discovering", messages: [{ role: "user" }, { role: "chief" }] });
  const draft = await service.addMessage(discovering.id, "目标成员是执简；正例是只提交目标文件，反例是混入无关文件。");
  expect(draft).toMatchObject({
    status: "draft", target_member_id: "deepseek_git_steward", target_service_id: "git.flow",
    package: { skill_id: "git-change-management", base_version: 3, version: 4, status: "draft" },
  });
  expect(draft.package?.skill_md).toContain("不得使用 git add .");
  const trialReady = service.validate(draft.id);
  expect(trialReady).toMatchObject({ status: "trial", package: { status: "validated" } });
  expect(trialReady.package?.digest).toBe(draft.package?.digest);

  const state = StateDatabase.open(dataDir);
  for (let index = 1; index <= 3; index += 1) {
    state.putRecord("skill_evaluation_evidence", `baseline-${index}`, {
      evidence_kind: "skill_evaluation", service_id: "git.flow",
      target_member_id: "deepseek_git_steward", reviewer_member_id: "qwen_worker",
      comparison_key: `demo-repository:git-scope:${index}`,
      skill: {}, accepted: index > 1, total_tokens: 1_000, latency_ms: 2_000,
    });
    state.putRecord("skill_evaluation_evidence", `trial-${index}`, {
      evidence_kind: "skill_evaluation", service_id: "git.flow",
      target_member_id: "deepseek_git_steward", reviewer_member_id: "qwen_worker",
      comparison_key: `demo-repository:git-scope:${index}`,
      skill: { commission_id: draft.id, digest: "loaded-prompt-digest", package_digest: trialReady.package?.digest },
      accepted: true, total_tokens: 800, latency_ms: 1_800,
    });
    service.recordTrial(draft.id, {
      baseline_evidence_id: `baseline-${index}`,
      trial_evidence_id: `trial-${index}`,
      reviewer_member_id: "qwen_worker",
      outcome: "accepted",
      summary: `第 ${index} 次独立试用通过`,
    });
  }
  expect(service.proposeActivation(draft.id).status).toBe("activation_proposed");
  const active = service.activate(draft.id, "operator");
  expect(active).toMatchObject({ status: "active", package: { version: 4, status: "active" } });
  expect(active.package?.digest).toBe(draft.package?.digest);
  expect(service.activePackage("git-change-management", "deepseek_git_steward", "git.flow")).toMatchObject({
    digest: active.package?.digest, version: 4,
  });
  expect(service.rollback(draft.id, "operator")).toMatchObject({
    status: "suspended", package: { status: "rolled_back" },
  });
  expect(service.activePackage("git-change-management", "deepseek_git_steward", "git.flow")).toBeUndefined();
  const next = await service.create("继续参考 https://example.com/git-guide 改进同一 Git 能力，但不能复用已经回滚的版本号。");
  expect(next.package).toMatchObject({ base_version: 3, version: 5 });
  await rm(dataDir, { recursive: true, force: true });
});

test("commission refuses arbitrary records that do not prove the commissioned Skill was used", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-evidence-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const provider: AgentProvider = { async generate() { return { content: JSON.stringify({
    ready: true, reply: "draft", title: "Git evidence", goal: "Bind trial evidence",
    skill_id: "git-change-management", target_member_id: "deepseek_git_steward",
    target_service_id: "git.flow", risk: "repository_mutation", trigger: "git task",
    instructions: ["one", "two"], boundaries: ["gate"],
    acceptance_examples: ["a", "b"], sources: [], requested_assets: ["git-flow-engine"],
  }) } } };
  const service = new SkillCommissionService(config, { get: () => provider }, dataDir);
  const draft = await service.create("创建一个有证据门禁的 Git 能力");
  service.validate(draft.id);
  const state = StateDatabase.open(dataDir);
  state.putRecord("benchmark_evidence", "made-up", { accepted: true });
  await expect(() => service.recordTrial(draft.id, {
    baseline_evidence_id: "made-up", trial_evidence_id: "made-up-2",
    reviewer_member_id: "qwen_worker", outcome: "accepted", summary: "not evidence",
  })).toThrow("verified evaluation payload");
  await rm(dataDir, { recursive: true, force: true });
});

test("commission rejects sources and permissions invented by the Chief", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-commission-boundary-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const provider: AgentProvider = { async generate() { return { content: JSON.stringify({
    ready: true, reply: "draft", title: "unsafe", goal: "unsafe",
    skill_id: "git-change-management", target_member_id: "deepseek_git_steward",
    target_service_id: "git.flow", risk: "read_only", trigger: "git task",
    instructions: ["one", "two"], boundaries: ["gate"],
    acceptance_examples: ["a", "b"], sources: ["https://invented.example/skill"],
    requested_assets: ["arbitrary-shell"],
  }) } } };
  const service = new SkillCommissionService(config, { get: () => provider }, dataDir);
  await expect(service.create("让执简学习一个能力")).rejects.toThrow("cannot downgrade");
  expect(service.list()[0]).toMatchObject({ status: "discovering" });
  await rm(dataDir, { recursive: true, force: true });
});

test("commission rejects a target member without the service capability", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-member-capability-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const provider: AgentProvider = { async generate() { return { content: JSON.stringify({
    ready: true, reply: "draft", title: "Git mismatch", goal: "Reject an ineligible target",
    skill_id: "git-change-management", target_member_id: "qwen_worker",
    target_service_id: "git.flow", risk: "repository_mutation", trigger: "git task",
    instructions: ["one", "two"], boundaries: ["gate"],
    acceptance_examples: ["a", "b"], sources: [], requested_assets: [],
  }) } } };
  const service = new SkillCommissionService(config, { get: () => provider }, dataDir);
  await expect(service.create("把 Git 专业服务交给不具备能力的成员"))
    .rejects.toThrow("lacks required service capabilities");
  await rm(dataDir, { recursive: true, force: true });
});

test("commission requires the service runtime asset even when the Chief omits it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-member-asset-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const target = config.agents.agents.find((member) => member.id === "qwen_worker")!;
  target.skills = [...new Set([...(target.skills ?? []), "git-flow-safety"])];
  target.tools = (target.tools ?? []).filter((tool) => tool !== "git-flow-engine");
  const provider: AgentProvider = { async generate() { return { content: JSON.stringify({
    ready: true, reply: "draft", title: "Git asset mismatch", goal: "Reject missing runtime asset",
    skill_id: "git-change-management", target_member_id: "qwen_worker",
    target_service_id: "git.flow", risk: "repository_mutation", trigger: "git task",
    instructions: ["one", "two"], boundaries: ["gate"],
    acceptance_examples: ["a", "b"], sources: [], requested_assets: [],
  }) } } };
  const service = new SkillCommissionService(config, { get: () => provider }, dataDir);
  await expect(service.create("目标成员没有 Git runtime asset"))
    .rejects.toThrow("lacks requested asset grants: git-flow-engine");
  await rm(dataDir, { recursive: true, force: true });
});
