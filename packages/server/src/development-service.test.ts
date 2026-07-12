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
    status: "awaiting_approval", specialist_member_id: "qwen_worker",
    reviewer_member_id: "mimo_scout", commit_message: "feat(demo): add greeting",
    files: ["src.ts"], review: { outcome: "accepted" },
  });

  const completed = await service.approve(proposal.id);
  expect(completed.status).toBe("completed");
  expect(completed.commit_sha).toMatch(/^[0-9a-f]{40}$/);
  expect((await command(root, ["log", "-1", "--pretty=%s"])).trim()).toBe("feat(demo): add greeting");
  expect(JSON.parse(await readFile(join(dataDir, "member-experience", "qwen_worker.json"), "utf8"))).toMatchObject([
    { verified: true, skill: { id: "git-change-management", version: 1 }, reviewer_outcome: "accepted" },
  ]);
  const skillProposals = await service.listSkillProposals();
  expect(skillProposals[0]).toMatchObject({
    status: "pending",
    proposed_addition: "提交前确认验证命令没有改写批准文件",
    evidence: { development_proposal_id: proposal.id, commit_sha: completed.commit_sha },
  });
  const activeSkill = await service.approveSkillProposal(skillProposals[0]!.id);
  expect(activeSkill).toMatchObject({ version: 2, additions: ["提交前确认验证命令没有改写批准文件"] });
  await writeFile(join(root, "src.ts"), "export const value = 1;\nexport const greeting = 'hello again';\n", "utf8");
  const nextProposal = await service.prepare(workplace.id, "继续按同一规范提交当前改动");
  expect(nextProposal.skill.version).toBe(2);
  const latestSpecialistPrompt = provider.requests.filter((request) => request.memberId === "qwen_worker").at(-1)?.messages.at(-1)?.content ?? "";
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

class DevelopmentProvider implements AgentProvider {
  readonly requests: ModelRequest[] = [];
  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (request.memberId === "deepseek_reasoner") {
      return { content: JSON.stringify({
        member_id: "qwen_worker",
        assignment_reason: "千工具备 Git 提交管理 Skill 和稳定的结构化执行能力",
        instruction: "审阅当前 Diff，按 Policy 生成提交计划，不修改代码",
      }) };
    }
    if (request.memberId === "qwen_worker") {
      return { content: JSON.stringify({
        summary: "新增 greeting 导出并保留现有行为",
        commit_message: "feat(demo): add greeting",
        files: ["src.ts"],
        risk: "低风险，仅新增导出",
        validation_commands: ["bun test"],
        experience_used: [],
        skill_improvement: "提交前确认验证命令没有改写批准文件",
      }) };
    }
    return { content: JSON.stringify({
      outcome: "accepted", rationale: "文件、命令和提交信息均符合 Policy", issues: [],
    }) };
  }
}

async function exampleConfig(): Promise<LocalConfigSet> {
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  validateLocalConfig(config);
  return config;
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "totemora-development-repo-"));
  await command(root, ["init", "-q"]);
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
