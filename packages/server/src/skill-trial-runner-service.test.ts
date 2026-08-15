import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig, type AgentProvider } from "@totemora/core";
import type { DevelopmentProposal } from "./development-service";
import { SkillCommissionService } from "./skill-commission-service";
import { SkillTrialRunnerService } from "./skill-trial-runner-service";
import { SpecialistTaskRepository } from "./specialist-service";

test("automatic Skill trial runs the same member twice and records independent review evidence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-trial-runner-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let drafting = true;
  const provider: AgentProvider = { async generate() {
    if (!drafting) return { content: JSON.stringify({ outcome: "accepted", rationale: "试用符合边界且不弱于基线", issues: [] }) };
    return { content: JSON.stringify({
      ready: true, reply: "draft", title: "Git evidence", goal: "Bind automatic trial evidence",
      skill_id: "git-flow-release", target_member_id: "deepseek_git_steward",
      target_service_id: "git.flow", risk: "repository_mutation", trigger: "git task",
      instructions: ["one", "two"], boundaries: ["gate"], acceptance_examples: ["a", "b"],
      sources: [], requested_assets: ["git-flow-engine"],
    }) };
  } };
  const registry = { get: () => provider };
  const commissions = new SkillCommissionService(config, registry, dataDir);
  const draft = await commissions.create("创建一个可以自动对照试炼的 Git 能力");
  const ready = commissions.validate(draft.id);
  drafting = false;
  const calls: Array<{ trial?: string; specialist: string }> = [];
  const runner = new SkillTrialRunnerService(config, registry, commissions, dataDir, async (_workplace, goal, options) => {
    calls.push({ trial: options.trial_commission_id, specialist: options.specialist_member_id });
    return proposal(goal, options.trial_commission_id, ready.package?.digest);
  });
  const started = runner.start(draft.id, {
    idempotency_key: "accepted-trial-1", workplace_id: "demo", goal: "提交当前范围", reviewer_member_id: "qwen_worker",
  });
  let completed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    completed = runner.get(started.id);
    if (["completed", "failed"].includes(completed?.status ?? "")) break;
    await Bun.sleep(5);
  }
  expect(completed).toMatchObject({
    status: "completed", stage: "completed", target_member_id: "deepseek_git_steward",
    reviewer_member_id: "qwen_worker", review: { outcome: "accepted" },
  });
  expect(calls).toEqual([
    { trial: undefined, specialist: "deepseek_git_steward" },
    { trial: draft.id, specialist: "deepseek_git_steward" },
  ]);
  expect(commissions.get(draft.id)?.trials).toHaveLength(1);
  expect(commissions.get(draft.id)?.trials[0]).toMatchObject({
    baseline_evidence_id: completed?.baseline_evidence_id,
    trial_evidence_id: completed?.trial_evidence_id,
    reviewer_member_id: "qwen_worker", outcome: "accepted",
  });
  expect(new SpecialistTaskRepository(dataDir).get(started.id)).toMatchObject({
    operation: "skill_trial", status: "completed", current_stage: "accepted",
    member_id: "deepseek_git_steward", result: { reviewer_member_id: "qwen_worker" },
  });
  commissions.cancel(draft.id);
  expect(runner.start(draft.id, {
    idempotency_key: "accepted-trial-1", workplace_id: "demo", goal: "提交当前范围", reviewer_member_id: "qwen_worker",
  }).id).toBe(started.id);
  expect(commissions.get(draft.id)?.trials).toHaveLength(1);
  await rm(dataDir, { recursive: true, force: true });
});

test("automatic Skill trial preserves an independent rejection without publishing a pass", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-trial-rejected-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let drafting = true;
  const provider: AgentProvider = { async generate() {
    if (!drafting) return { content: JSON.stringify({ outcome: "rejected", rationale: "试用扩大了边界", issues: ["unsafe scope"] }) };
    return { content: JSON.stringify({
      ready: true, reply: "draft", title: "Git evidence", goal: "Reject unsafe trial",
      skill_id: "git-flow-release", target_member_id: "deepseek_git_steward",
      target_service_id: "git.flow", risk: "repository_mutation", trigger: "git task",
      instructions: ["one", "two"], boundaries: ["gate"], acceptance_examples: ["a", "b"],
      sources: [], requested_assets: ["git-flow-engine"],
    }) };
  } };
  const registry = { get: () => provider };
  const commissions = new SkillCommissionService(config, registry, dataDir);
  const draft = await commissions.create("创建一个应当被拒绝的试炼");
  commissions.validate(draft.id);
  drafting = false;
  const runner = new SkillTrialRunnerService(config, registry, commissions, dataDir, async (_workplace, goal, options) => (
    proposal(goal, options.trial_commission_id, commissions.get(draft.id)?.package?.digest)
  ));
  const started = runner.start(draft.id, {
    idempotency_key: "rejected-trial-1", workplace_id: "demo", goal: "提交当前范围", reviewer_member_id: "qwen_worker",
  });
  let completed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    completed = runner.get(started.id);
    if (["completed", "failed"].includes(completed?.status ?? "")) break;
    await Bun.sleep(5);
  }
  expect(completed).toMatchObject({ status: "completed", review: { outcome: "rejected" } });
  expect(commissions.get(draft.id)?.trials).toMatchObject([{ id: started.id, outcome: "rejected" }]);
  const task = new SpecialistTaskRepository(dataDir).get(started.id);
  expect(task).toMatchObject({ status: "completed", current_stage: "rejected" });
  expect(task?.events?.at(-1)).toMatchObject({
    type: "completed", stage: "rejected", summary: "成员试炼未通过，证据已登记",
  });
  await rm(dataDir, { recursive: true, force: true });
});

test("automatic Skill trial rejects invalid enums and conflicting active input", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-skill-trial-input-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const provider: AgentProvider = { async generate() { return { content: JSON.stringify({
    ready: true, reply: "draft", title: "Git evidence", goal: "Input validation",
    skill_id: "git-flow-release", target_member_id: "deepseek_git_steward",
    target_service_id: "git.flow", risk: "repository_mutation", trigger: "git task",
    instructions: ["one", "two"], boundaries: ["gate"], acceptance_examples: ["a", "b"],
    sources: [], requested_assets: ["git-flow-engine"],
  }) }; } };
  const registry = { get: () => provider };
  const commissions = new SkillCommissionService(config, registry, dataDir);
  const draft = await commissions.create("创建输入校验试炼");
  commissions.validate(draft.id);
  let release!: () => void;
  const blocked = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const runner = new SkillTrialRunnerService(config, registry, commissions, dataDir, async (_workplace, goal, options) => {
    await blocked;
    return proposal(goal, options.trial_commission_id, commissions.get(draft.id)?.package?.digest);
  });
  expect(() => runner.start(draft.id, {
    idempotency_key: "invalid-enum-1", workplace_id: "demo", goal: "bad", reviewer_member_id: "qwen_worker", mode: "bad" as "commit",
  })).toThrow("Invalid Skill trial mode");
  const started = runner.start(draft.id, {
    idempotency_key: "active-trial-1", workplace_id: "demo", goal: "first", reviewer_member_id: "qwen_worker",
  });
  expect(runner.start(draft.id, {
    idempotency_key: "active-trial-1", workplace_id: "demo", goal: "first", reviewer_member_id: "qwen_worker",
  }).id).toBe(started.id);
  expect(() => runner.start(draft.id, {
    idempotency_key: "active-trial-2", workplace_id: "demo", goal: "different", reviewer_member_id: "qwen_worker",
  }))
    .toThrow("different automatic trial");
  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (["completed", "failed"].includes(runner.get(started.id)?.status ?? "")) break;
    await Bun.sleep(5);
  }
  await rm(dataDir, { recursive: true, force: true });
});

function proposal(goal: string, commissionId?: string, packageDigest?: string): DevelopmentProposal {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), status: "awaiting_approval", mode: "commit", issue_mode: "none",
    workplace_id: "demo", workplace_name: "Demo", goal, created_at: now, updated_at: now,
    snapshot_hash: "same-snapshot", policy_version: 1,
    chief_member_id: "deepseek_reasoner", specialist_member_id: "deepseek_git_steward",
    assignment_reason: "能力匹配",
    skill: {
      id: "git-flow-release", version: commissionId ? 5 : 4, digest: commissionId ? "trial-loaded" : "baseline-loaded",
      ...(commissionId ? { commission_id: commissionId, package_digest: packageDigest } : {}),
    },
    evaluation: { accepted: true, calls: 2, total_tokens: commissionId ? 800 : 1_000, usage_status: "measured", latency_ms: 100 },
    git_context: { branch: "main", has_develop: false, unpushed_commits: 0, stash_count: 0 },
    files: ["README.md"], summary: commissionId ? "trial" : "baseline", commit_message: "docs: update",
    risk: "low", validation_commands: ["bun test"], experience_used: [],
    self_check: { outcome: "accepted", rationale: "ok", issues: [] },
    chief_acceptance: { outcome: "accepted", rationale: "ok", issues: [] }, activities: [],
  };
}
