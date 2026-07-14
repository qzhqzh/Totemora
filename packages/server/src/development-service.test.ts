import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AgentProvider, LocalConfigSet, ModelRequest, ModelResponse } from "@totemora/core";
import { loadLocalConfig, validateLocalConfig } from "@totemora/core";

import { DevelopmentCommitService } from "./development-service";
import { SettlementStore } from "./settlement-store";

test("chief delegates a policy-bound commit and approval creates verified experience", async () => {
  const root = await createRepository();
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-development-data-"));
  const settlement = new SettlementStore(dataDir);
  const workplace = await settlement.addWorkplace("Demo Repo", root);
  await settlement.setWorkplacePolicy(workplace.id, {
    instructions: "只提交当前目标相关改动；使用 conventional commits；验证测试。",
    validation_commands: ["bun test"],
    allowed_commit_types: ["feat", "fix", "test", "chore"],
    forbidden_paths: [".env", "secrets/"],
  });
  const config = await exampleConfig();
  const provider = new DevelopmentProvider();
  const service = new DevelopmentCommitService(
    config, { get: () => provider }, settlement, dataDir,
    resolve(import.meta.dir, "../../.."),
  );

  const proposal = await service.prepare(workplace.id, "按项目规范提交当前改动");
  expect(proposal).toMatchObject({
    status: "awaiting_approval", specialist_member_id: "deepseek_git_steward",
    commit_message: "feat(demo): add greeting",
    files: ["src.ts"], self_check: { outcome: "accepted" }, chief_acceptance: { outcome: "accepted" },
    skill: { id: "git-change-management", version: 3 },
    git_context: { branch: "main", has_develop: false, unpushed_commits: 0, stash_count: 0 },
  });
  expect(provider.requests.find((request) => request.memberId === "deepseek_git_steward")?.maxTokens).toBe(8_000);

  const completed = await service.approve(proposal.id);
  expect(completed.status).toBe("completed");
  expect(completed.commit_sha).toMatch(/^[0-9a-f]{40}$/);
  expect((await command(root, ["log", "-1", "--pretty=%s"])).trim()).toBe("feat(demo): add greeting");
  expect(JSON.parse(await readFile(join(dataDir, "member-experience", "deepseek_git_steward.json"), "utf8"))).toMatchObject([
    { verified: true, skill: { id: "git-change-management", version: 3 }, self_check_outcome: "accepted", chief_acceptance: "accepted" },
  ]);
  const skillProposals = await service.listSkillProposals();
  expect(skillProposals[0]).toMatchObject({
    status: "pending",
    proposed_addition: "提交前确认验证命令没有改写批准文件",
    evidence: { development_proposal_id: proposal.id, commit_sha: completed.commit_sha },
  });
  const activeSkill = await service.approveSkillProposal(skillProposals[0]!.id);
  expect(activeSkill).toMatchObject({ version: 4, additions: ["提交前确认验证命令没有改写批准文件"] });
  await writeFile(join(root, "src.ts"), "export const value = 1;\nexport const greeting = 'hello again';\n", "utf8");
  const nextProposal = await service.prepare(workplace.id, "继续按同一规范提交当前改动");
  expect(nextProposal.skill.version).toBe(4);
  const latestSpecialistPrompt = provider.requests.filter((request) => request.memberId === "deepseek_git_steward").at(-1)?.messages.at(-1)?.content ?? "";
  expect(latestSpecialistPrompt).toContain(completed.commit_sha!);
  expect(latestSpecialistPrompt).toContain("git-change-management");
  expect(latestSpecialistPrompt).toContain("提交前确认验证命令没有改写批准文件");
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

test("refuses to prepare a commit containing a secret path", async () => {
  const root = await createRepository();
  await writeFile(join(root, ".env"), "TOKEN=secret\n", "utf8");
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-development-secret-"));
  const settlement = new SettlementStore(dataDir);
  const workplace = await settlement.addWorkplace("Secret Repo", root);
  await settlement.setWorkplacePolicy(workplace.id, {
    instructions: "不得提交密钥", validation_commands: [],
    allowed_commit_types: ["chore"], forbidden_paths: [".env"],
  });
  const service = new DevelopmentCommitService(
    await exampleConfig(), { get: () => new DevelopmentProvider() }, settlement,
    dataDir, resolve(import.meta.dir, "../../.."),
  );
  await expect(service.prepare(workplace.id, "提交当前改动")).rejects.toThrow("Forbidden path cannot be committed: .env");
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

test("invalidates approval when the working tree changes after proposal", async () => {
  const root = await createRepository();
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-development-snapshot-"));
  const settlement = new SettlementStore(dataDir);
  const workplace = await settlement.addWorkplace("Changing Repo", root);
  await settlement.setWorkplacePolicy(workplace.id, {
    instructions: "验证后提交", validation_commands: ["bun test"],
    allowed_commit_types: ["feat"], forbidden_paths: [".env"],
  });
  const service = new DevelopmentCommitService(
    await exampleConfig(), { get: () => new DevelopmentProvider() }, settlement,
    dataDir, resolve(import.meta.dir, "../../.."),
  );
  const proposal = await service.prepare(workplace.id, "提交当前改动");
  await writeFile(join(root, "src.ts"), "export const value = 2;\n", "utf8");
  await expect(service.approve(proposal.id)).rejects.toThrow("Git working tree changed after approval proposal");
  expect((await command(root, ["log", "--oneline"])).trim().split("\n")).toHaveLength(1);
  expect((await command(root, ["diff", "--cached", "--name-only"])).trim()).toBe("");
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

test("gives the specialist bounded feedback to repair an invalid plan", async () => {
  const root = await createRepository();
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-development-repair-"));
  const settlement = new SettlementStore(dataDir);
  const workplace = await settlement.addWorkplace("Repair Repo", root);
  await settlement.setWorkplacePolicy(workplace.id, {
    instructions: "验证后提交", validation_commands: ["bun test"],
    allowed_commit_types: ["feat"], forbidden_paths: [".env"],
  });
  const provider = new SelfCorrectingDevelopmentProvider();
  const service = new DevelopmentCommitService(
    await exampleConfig(), { get: () => provider }, settlement,
    dataDir, resolve(import.meta.dir, "../../.."),
  );

  const proposal = await service.prepare(workplace.id, "提交当前改动");
  expect(proposal).toMatchObject({ status: "awaiting_approval", commit_message: "feat(demo): add greeting" });
  expect(provider.requests.some((request) => request.messages.at(-1)?.content.includes("does not satisfy Policy"))).toBe(true);
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

test("does not commit or leave staged files when policy validation fails", async () => {
  const root = await createRepository();
  await writeFile(join(root, "src.test.ts"), "import { expect, test } from 'bun:test';\nimport { value } from './src';\ntest('value', () => expect(value).toBe(2));\n", "utf8");
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-development-validation-"));
  const settlement = new SettlementStore(dataDir);
  const workplace = await settlement.addWorkplace("Failing Repo", root);
  await settlement.setWorkplacePolicy(workplace.id, {
    instructions: "测试通过后才能提交", validation_commands: ["bun test"],
    allowed_commit_types: ["feat"], forbidden_paths: [".env"],
  });
  const service = new DevelopmentCommitService(
    await exampleConfig(), { get: () => new DevelopmentProvider() }, settlement,
    dataDir, resolve(import.meta.dir, "../../.."),
  );
  const proposal = await service.prepare(workplace.id, "提交当前改动");
  const result = await service.approve(proposal.id);
  expect(result).toMatchObject({ status: "failed", error: "Validation failed: bun test" });
  expect((await command(root, ["log", "--oneline"])).trim().split("\n")).toHaveLength(1);
  expect((await command(root, ["diff", "--cached", "--name-only"])).trim()).toBe("");
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

test("one durable workflow reaches Issue, reviewed PR, merge and Chief report", async () => {
  const root = await createRepository();
  const remote = await mkdtemp(join(tmpdir(), "totemora-development-remote-"));
  await command(remote, ["init", "--bare", "-q"]);
  await command(root, ["remote", "add", "origin", remote]);
  await command(root, ["push", "-u", "origin", "main"]);
  await command(root, ["checkout", "-qb", "test/tribe-git-flow"]);
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-git-flow-data-"));
  const settlement = new SettlementStore(dataDir);
  const workplace = await settlement.addWorkplace("Git Flow Repo", root);
  await settlement.setWorkplacePolicy(workplace.id, {
    instructions: "测试改动走 Issue、PR、评审和 squash merge；只提交 src.ts。",
    validation_commands: ["bun test"],
    allowed_commit_types: ["feat", "test"],
    forbidden_paths: [".env"],
    git_flow: {
      remote_provider: "github", target_branch: "main",
      allow_issue: true, allow_push: true, allow_pull_request: true, allow_merge: true,
      allow_opencode_fix: false,
    },
  });
  const provider = new DevelopmentProvider();
  let merged = false;
  const external = async (cwd: string, executable: string, args: string[]) => {
    expect(executable).toBe("gh");
    const operation = `${args[0]} ${args[1]}`;
    if (operation === "issue create") return { stdout: "https://github.com/example/repo/issues/7\n", stderr: "" };
    if (operation === "pr list") return { stdout: "[]", stderr: "" };
    if (operation === "pr create") return { stdout: "https://github.com/example/repo/pull/9\n", stderr: "" };
    if (operation === "pr diff") return { stdout: "diff --git a/src.ts b/src.ts\n+export const greeting = 'hello';\n", stderr: "" };
    if (operation === "pr merge") {
      await command(cwd, ["checkout", "main"]);
      await command(cwd, ["merge", "--squash", "test/tribe-git-flow"]);
      await command(cwd, ["commit", "-qm", "test: merge tribe git flow example"]);
      await command(cwd, ["push", "origin", "main"]);
      await command(cwd, ["checkout", "test/tribe-git-flow"]);
      merged = true;
      return { stdout: "", stderr: "" };
    }
    if (operation === "pr view" && args.includes("files")) return { stdout: JSON.stringify({ files: [{ path: "src.ts" }] }), stderr: "" };
    if (operation === "pr view") return {
      stdout: JSON.stringify(merged
        ? { state: "MERGED", mergedAt: new Date().toISOString(), mergeCommit: { oid: "a".repeat(40) }, url: "https://github.com/example/repo/pull/9" }
        : { state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", url: "https://github.com/example/repo/pull/9" }),
      stderr: "",
    };
    throw new Error(`Unexpected external command: ${executable} ${args.join(" ")}`);
  };
  const service = new DevelopmentCommitService(
    await exampleConfig(), { get: () => provider }, settlement, dataDir,
    resolve(import.meta.dir, "../../.."), external,
  );

  const workflow = await service.prepare(workplace.id, "把测试改动完整走到 main", { mode: "merge", issue_mode: "auto" });
  expect(workflow).toMatchObject({
    status: "awaiting_approval", mode: "merge", issue_mode: "auto",
    specialist_member_id: "deepseek_git_steward", chief_acceptance: { outcome: "accepted" },
  });
  const committed = await service.approve(workflow.id);
  expect(committed.status).toBe("awaiting_remote_approval");
  const published = await service.publish(workflow.id);
  expect(published).toMatchObject({
    status: "awaiting_merge_approval", issue_number: 7, pr_number: 9,
    pr_review: { outcome: "accepted" }, chief_acceptance: { outcome: "accepted" },
  });
  const completed = await service.merge(workflow.id);
  expect(completed).toMatchObject({
    status: "completed", chief_report: { acceptance: "passed" },
  });
  expect((await command(root, ["branch", "--show-current"])).trim()).toBe("main");
  expect(completed.activities.map((item) => item.phase)).toEqual([
    "assigned", "planned", "chief_accepted", "committed", "issue_created", "pushed",
    "pr_created", "merge_ready", "merged",
  ]);
  await rm(root, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

class DevelopmentProvider implements AgentProvider {
  readonly requests: ModelRequest[] = [];
  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const prompt = request.messages.at(-1)?.content ?? "";
    if (request.memberId === "deepseek_reasoner") {
      if (prompt.includes("最终验收报告")) {
        return { content: JSON.stringify({ summary: "Git Flow 已完成", acceptance: "passed", evidence: ["Issue #7", "PR #9", "validation passed"] }) };
      }
      if (prompt.includes("验收 Git Flow 专员") || prompt.includes("真实 PR 评审")) {
        return { content: JSON.stringify({ outcome: "accepted", rationale: "真实 Diff、Policy 与自检一致", issues: [] }) };
      }
      return { content: JSON.stringify({
        member_id: "deepseek_git_steward",
        assignment_reason: "执简具备 Git Flow 安全检查 Skill 和稳定的结构化执行能力",
        instruction: "审阅当前 Diff，按 Policy 生成提交计划，不修改代码",
      }) };
    }
    if (request.memberId === "deepseek_git_steward") {
      if (prompt.includes("评审真实 PR Diff")) {
        return { content: JSON.stringify({ outcome: "accepted", rationale: "PR Diff 与目标一致且验证通过", issues: [] }) };
      }
      return { content: JSON.stringify({
        summary: "新增 greeting 导出并保留现有行为",
        commit_message: "feat(demo): add greeting",
        files: ["src.ts"],
        risk: "低风险，仅新增导出",
        validation_commands: ["bun test"],
        experience_used: [],
        skill_improvement: "提交前确认验证命令没有改写批准文件",
        self_check: { outcome: "accepted", rationale: "范围与验证命令均符合 Policy", issues: [] },
        remote_plan: {
          target_branch: "main", branch_name: "test/tribe-git-flow", issue_title: "test: verify tribe Git Flow",
          issue_body: "验证完整 Git Flow", pr_title: "test: verify tribe Git Flow",
          pr_body: "新增测试改动并完成验证",
        },
      }) };
    }
    return { content: JSON.stringify({
      outcome: "accepted", rationale: "文件、命令和提交信息均符合 Policy", issues: [],
    }) };
  }
}

class SelfCorrectingDevelopmentProvider implements AgentProvider {
  readonly requests: ModelRequest[] = [];
  private readonly valid = new DevelopmentProvider();
  private invalidPlanReturned = false;

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const prompt = request.messages.at(-1)?.content ?? "";
    if (request.memberId === "deepseek_git_steward" && !prompt.includes("评审真实 PR Diff") && !this.invalidPlanReturned) {
      this.invalidPlanReturned = true;
      return { content: JSON.stringify({
        summary: "计划",
        commit_message: "update files",
        files: ["src.ts"],
        risk: "low",
        validation_commands: ["bun test"],
        experience_used: [],
        self_check: { outcome: "accepted", rationale: "已检查", issues: [] },
      }) };
    }
    return this.valid.generate(request);
  }
}

async function exampleConfig(): Promise<LocalConfigSet> {
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  validateLocalConfig(config);
  return config;
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "totemora-development-repo-"));
  await command(root, ["init", "-q", "-b", "main"]);
  await command(root, ["config", "user.name", "Totemora Test"]);
  await command(root, ["config", "user.email", "totemora@example.test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");
  await writeFile(join(root, "src.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(root, "src.test.ts"), "import { expect, test } from 'bun:test';\nimport { value } from './src';\ntest('value', () => expect(value).toBe(1));\n", "utf8");
  await command(root, ["add", "."]);
  await command(root, ["commit", "-qm", "chore: initialize fixture"]);
  await writeFile(join(root, "src.ts"), "export const value = 1;\nexport const greeting = 'hello';\n", "utf8");
  return root;
}

async function command(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}
