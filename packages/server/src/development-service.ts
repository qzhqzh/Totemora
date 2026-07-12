import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { AgentConfig, LocalConfigSet, ProviderRegistry } from "@totemora/core";

import type { SettlementStore, Workplace, WorkplacePolicy } from "./settlement-store";
import { SkillGovernanceStore } from "./skill-governance-store";

export interface DevelopmentProposal {
  id: string;
  status: "awaiting_approval" | "executing" | "completed" | "failed";
  workplace_id: string;
  workplace_name: string;
  goal: string;
  created_at: string;
  updated_at: string;
  snapshot_hash: string;
  policy_version: number;
  chief_member_id: string;
  specialist_member_id: string;
  reviewer_member_id: string;
  assignment_reason: string;
  skill: { id: string; version: number };
  files: string[];
  summary: string;
  commit_message: string;
  risk: string;
  validation_commands: string[];
  experience_used: string[];
  skill_improvement?: string;
  review: { outcome: "accepted" | "rejected"; rationale: string; issues: string[] };
  validation_results?: Array<{ command: string; exit_code: number; output: string }>;
  commit_sha?: string;
  error?: string;
}

interface GitSnapshot {
  hash: string;
  files: string[];
  status: string;
  diff: string;
  conventions: string;
}

interface SpecialistOutput {
  summary: string;
  commit_message: string;
  files: string[];
  risk: string;
  validation_commands: string[];
  experience_used: string[];
  skill_improvement?: string;
}

export class DevelopmentCommitService {
  private readonly proposalsDir: string;
  private readonly experienceFile: string;
  private readonly skillStore: SkillGovernanceStore;

  constructor(
    private readonly config: LocalConfigSet,
    private readonly providers: ProviderRegistry,
    private readonly settlement: SettlementStore,
    dataDir: string,
    private readonly projectRoot: string,
  ) {
    this.proposalsDir = resolve(dataDir, "development", "proposals");
    this.experienceFile = resolve(dataDir, "member-experience", "qwen_worker.json");
    this.skillStore = new SkillGovernanceStore(dataDir, "git-change-management");
  }

  async prepare(workplaceId: string, goal: string): Promise<DevelopmentProposal> {
    const workplace = await this.getWorkplace(workplaceId);
    const policy = requirePolicy(workplace);
    const snapshot = await collectGitSnapshot(workplace.path, policy);
    const chief = requireMember(this.config, this.config.tribe.tribe.chief ?? "deepseek_reasoner");
    const specialist = requireMember(this.config, "qwen_worker");
    const reviewer = requireMember(this.config, "mimo_scout");
    const baseSkill = await readFile(resolve(this.projectRoot, "skills/git-change-management/SKILL.md"), "utf8");
    const skill = await this.skillStore.getActive(baseSkill);
    const experiences = await this.loadExperiences();

    const assignment = await this.callJson(chief, [
      "你是 Totemora Chief。用户要求按项目规范提交当前已有改动。",
      `目标：${goal}`,
      `项目规范：${policy.instructions}`,
      `变更文件：${JSON.stringify(snapshot.files)}`,
      "必须把任务交给 qwen_worker，范围仅限审阅现有 Diff、制定验证计划和提交信息；不得修改代码、push 或扩大范围。",
      "只输出 JSON：{member_id:'qwen_worker',assignment_reason,instruction}。",
    ].join("\n")) as { member_id?: string; assignment_reason?: string; instruction?: string };
    if (assignment.member_id !== specialist.id || !assignment.assignment_reason || !assignment.instruction) {
      throw new Error("Chief did not assign the development commit task to qwen_worker");
    }

    const specialistOutput = await this.callJson(specialist, [
      specialist.persona ?? "",
      `Skill v${skill.version}：\n${skill.content}`,
      `最近已验证经验：${JSON.stringify(experiences.slice(-5))}`,
      `Chief 工作包：${assignment.instruction}`,
      `Workplace Policy：${JSON.stringify(policy)}`,
      `Git status：\n${snapshot.status}`,
      `Git diff 与未跟踪文件摘要：\n${snapshot.diff}`,
      `项目规范文件：\n${snapshot.conventions}`,
      "只按 Skill 输出 JSON。不要声称测试已执行。",
    ].join("\n")) as SpecialistOutput;
    validateSpecialistOutput(
      specialistOutput,
      snapshot.files,
      policy,
      new Set(experiences.map((item) => String(item.id ?? ""))),
    );

    const review = await this.callJson(reviewer, [
      "你是独立提交 Reviewer。检查 Proposal 是否忠实于真实 Diff、项目规范和安全边界。",
      `Policy：${JSON.stringify(policy)}`,
      `Snapshot 文件：${JSON.stringify(snapshot.files)}`,
      `Proposal：${JSON.stringify(specialistOutput)}`,
      "只输出 JSON：{outcome:'accepted'|'rejected',rationale,issues:string[]}。",
    ].join("\n")) as DevelopmentProposal["review"];
    if (!review || !["accepted", "rejected"].includes(review.outcome) || !review.rationale || !Array.isArray(review.issues)) {
      throw new Error("Independent reviewer returned an invalid development review");
    }

    const now = new Date().toISOString();
    const proposal: DevelopmentProposal = {
      id: crypto.randomUUID(),
      status: "awaiting_approval",
      workplace_id: workplace.id,
      workplace_name: workplace.name,
      goal,
      created_at: now,
      updated_at: now,
      snapshot_hash: snapshot.hash,
      policy_version: policy.version,
      chief_member_id: chief.id,
      specialist_member_id: specialist.id,
      reviewer_member_id: reviewer.id,
      assignment_reason: assignment.assignment_reason,
      skill: { id: "git-change-management", version: skill.version },
      files: specialistOutput.files,
      summary: specialistOutput.summary,
      commit_message: specialistOutput.commit_message,
      risk: specialistOutput.risk,
      validation_commands: specialistOutput.validation_commands,
      experience_used: specialistOutput.experience_used,
      skill_improvement: specialistOutput.skill_improvement,
      review,
    };
    await this.saveProposal(proposal);
    return proposal;
  }

  async approve(proposalId: string): Promise<DevelopmentProposal> {
    const proposal = await this.getProposal(proposalId);
    if (proposal.status !== "awaiting_approval") throw new Error(`Proposal cannot execute from status ${proposal.status}`);
    if (proposal.review.outcome !== "accepted") throw new Error("Independent reviewer rejected this proposal");
    const workplace = await this.getWorkplace(proposal.workplace_id);
    const policy = requirePolicy(workplace);
    if (policy.version !== proposal.policy_version) throw new Error("Workplace Policy changed; prepare a new proposal");
    const snapshot = await collectGitSnapshot(workplace.path, policy);
    if (snapshot.hash !== proposal.snapshot_hash) throw new Error("Git working tree changed after approval proposal; prepare again");

    proposal.status = "executing";
    proposal.updated_at = new Date().toISOString();
    await this.saveProposal(proposal);
    try {
      proposal.validation_results = [];
      for (const command of proposal.validation_commands) {
        const result = await runValidation(command, workplace.path);
        proposal.validation_results.push(result);
        if (result.exit_code !== 0) throw new Error(`Validation failed: ${command}`);
      }
      const afterValidation = await collectGitSnapshot(workplace.path, policy);
      if (afterValidation.hash !== proposal.snapshot_hash) {
        throw new Error("Validation changed the approved Git Snapshot; review the new changes before committing");
      }
      await git(workplace.path, ["add", "--", ...proposal.files]);
      const staged = await git(workplace.path, ["diff", "--cached", "--name-only"]);
      const stagedFiles = staged.stdout.trim().split("\n").filter(Boolean).sort();
      if (JSON.stringify(stagedFiles) !== JSON.stringify([...proposal.files].sort())) {
        throw new Error("Staged files differ from approved proposal");
      }
      await git(workplace.path, ["commit", "-m", proposal.commit_message]);
      proposal.commit_sha = (await git(workplace.path, ["rev-parse", "HEAD"])).stdout.trim();
      proposal.status = "completed";
      proposal.updated_at = new Date().toISOString();
      await this.saveProposal(proposal);
      await this.recordExperience(proposal);
      if (proposal.skill_improvement && proposal.commit_sha) {
        await this.skillStore.propose(proposal.skill_improvement, {
          development_proposal_id: proposal.id,
          commit_sha: proposal.commit_sha,
        });
      }
      return proposal;
    } catch (error) {
      await git(workplace.path, ["reset"]).catch(() => undefined);
      proposal.status = "failed";
      proposal.error = error instanceof Error ? error.message : String(error);
      proposal.updated_at = new Date().toISOString();
      await this.saveProposal(proposal);
      return proposal;
    }
  }

  async getProposal(id: string): Promise<DevelopmentProposal> {
    try {
      return JSON.parse(await readFile(join(this.proposalsDir, `${id}.json`), "utf8")) as DevelopmentProposal;
    } catch (error) {
      throw new Error(`Development proposal not found: ${id}`, { cause: error });
    }
  }

  async listProposals(): Promise<DevelopmentProposal[]> {
    let files: string[];
    try { files = (await readdir(this.proposalsDir)).filter((file) => file.endsWith(".json")); }
    catch { return []; }
    const proposals = await Promise.all(files.map(async (file) => {
      try { return JSON.parse(await readFile(join(this.proposalsDir, file), "utf8")) as DevelopmentProposal; }
      catch { return undefined; }
    }));
    return proposals.filter((item) => item !== undefined)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async listSkillProposals() {
    return this.skillStore.listProposals();
  }

  async approveSkillProposal(proposalId: string) {
    return this.skillStore.approve(proposalId);
  }

  private async getWorkplace(id: string): Promise<Workplace> {
    const workplace = (await this.settlement.get()).workplaces.find((item) => item.id === id);
    if (!workplace) throw new Error("工作地不存在");
    return workplace;
  }

  private async callJson(member: AgentConfig, prompt: string): Promise<unknown> {
    const response = await this.providers.get(member.provider).generate({
      memberId: member.id,
      model: member.model,
      messages: [
        { role: "system", content: member.persona ?? `你是部落成员 ${member.id}` },
        { role: "user", content: prompt },
      ],
      responseFormat: "json",
      maxTokens: 4000,
    });
    return parseJson(response.content);
  }

  private async saveProposal(proposal: DevelopmentProposal): Promise<void> {
    await mkdir(this.proposalsDir, { recursive: true });
    await atomicWrite(join(this.proposalsDir, `${proposal.id}.json`), proposal);
  }

  private async loadExperiences(): Promise<Array<Record<string, unknown>>> {
    try { return JSON.parse(await readFile(this.experienceFile, "utf8")) as Array<Record<string, unknown>>; }
    catch { return []; }
  }

  private async recordExperience(proposal: DevelopmentProposal): Promise<void> {
    const experiences = await this.loadExperiences();
    experiences.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      workplace_id: proposal.workplace_id,
      skill: proposal.skill,
      summary: proposal.summary,
      validation_commands: proposal.validation_commands,
      reviewer_outcome: proposal.review.outcome,
      commit_sha: proposal.commit_sha,
      verified: true,
    });
    await mkdir(dirname(this.experienceFile), { recursive: true });
    await atomicWrite(this.experienceFile, experiences.slice(-50));
  }
}

function requirePolicy(workplace: Workplace): WorkplacePolicy {
  if (!workplace.policy) throw new Error("工作地尚未安装开发提交规范");
  return workplace.policy;
}

function requireMember(config: LocalConfigSet, id: string): AgentConfig {
  const member = config.agents.agents.find((item) => item.id === id);
  if (!member || member.status === "inactive" || member.status === "retired") {
    throw new Error(`Required tribe member is unavailable: ${id}`);
  }
  return member;
}

async function collectGitSnapshot(root: string, policy: WorkplacePolicy): Promise<GitSnapshot> {
  await git(root, ["rev-parse", "--show-toplevel"]);
  for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    try { await stat(join(root, ".git", marker)); throw new Error(`Git operation in progress: ${marker}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const cached = await git(root, ["diff", "--cached", "--name-only"]);
  if (cached.stdout.trim()) throw new Error("Development commit workflow requires no pre-staged changes");
  const tracked = (await git(root, ["diff", "--name-only", "HEAD"])).stdout.trim().split("\n").filter(Boolean);
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"])).stdout.trim().split("\n").filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].sort();
  if (!files.length) throw new Error("Git workplace has no changes to commit");
  for (const file of files) {
    assertSafePath(file, policy);
    try {
      const content = await readFile(join(root, file));
      if (!content.includes(0)) assertNoSecretContent(file, content.toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const status = (await git(root, ["status", "--short", "--untracked-files=all"])).stdout;
  let diff = (await git(root, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", ...tracked])).stdout;
  for (const file of untracked) {
    const content = await readBoundedText(join(root, file), 8_000);
    diff += `\n--- /dev/null\n+++ b/${file}\n[untracked preview]\n${content}`;
  }
  diff = diff.slice(0, 60_000);
  const conventions = await readConventionFiles(root);
  const hash = createHash("sha256");
  hash.update(status);
  hash.update(JSON.stringify({ policy_version: policy.version, files }));
  for (const file of files) {
    try { hash.update(await readFile(join(root, file))); }
    catch { hash.update("[deleted]"); }
  }
  return { hash: hash.digest("hex"), files, status, diff, conventions };
}

function assertNoSecretContent(file: string, content: string): void {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-proj-[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{16,}/,
    /\bAKIA[A-Z0-9]{16}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(content))) {
    throw new Error(`Secret-like content cannot be committed without manual handling: ${file}`);
  }
}

function assertSafePath(file: string, policy: WorkplacePolicy): void {
  const normalized = file.replaceAll("\\", "/");
  const defaultForbidden = [".env", "*.pem", "*.key", "*credentials*", "*secret*", ".totemora/"];
  const patterns = [...defaultForbidden, ...policy.forbidden_paths];
  if (normalized.startsWith("/") || normalized.includes("../") || patterns.some((pattern) => pathMatches(normalized, pattern))) {
    throw new Error(`Forbidden path cannot be committed: ${file}`);
  }
}

function pathMatches(file: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").toLowerCase();
  const candidate = file.toLowerCase();
  if (normalized.includes("*")) {
    const expression = normalized.split("*").map(escapeRegExp).join(".*");
    return new RegExp(`^${expression}$`).test(candidate);
  }
  return candidate === normalized || candidate.startsWith(normalized.endsWith("/") ? normalized : `${normalized}/`) || basename(candidate) === normalized;
}

function validateSpecialistOutput(
  output: SpecialistOutput,
  snapshotFiles: string[],
  policy: WorkplacePolicy,
  availableExperienceIds: Set<string>,
): void {
  if (!output || !output.summary || !output.commit_message || !output.risk || !Array.isArray(output.files) || !Array.isArray(output.validation_commands) || !Array.isArray(output.experience_used)) {
    throw new Error("Commit specialist returned an invalid proposal");
  }
  if (output.skill_improvement !== undefined && typeof output.skill_improvement !== "string") {
    throw new Error("Commit specialist returned an invalid Skill improvement");
  }
  if (!output.files.length || output.files.some((file) => !snapshotFiles.includes(file))) {
    throw new Error("Commit specialist selected files outside the Git Snapshot");
  }
  if (output.validation_commands.some((command) => !policy.validation_commands.includes(command))) {
    throw new Error("Commit specialist selected a validation command outside Workplace Policy");
  }
  if (output.experience_used.some((id) => !availableExperienceIds.has(id))) {
    throw new Error("Commit specialist referenced an unknown experience");
  }
  const allowed = policy.allowed_commit_types.map(escapeRegExp).join("|");
  if (!new RegExp(`^(${allowed})(\\([a-z0-9._/-]+\\))?: .{1,72}$`).test(output.commit_message)) {
    throw new Error("Commit message does not satisfy Workplace Policy");
  }
  for (const file of output.files) assertSafePath(file, policy);
}

async function readConventionFiles(root: string): Promise<string> {
  const candidates = ["AGENTS.md", "CONTRIBUTING.md", "docs/development.md", ".github/CONTRIBUTING.md"];
  const parts: string[] = [];
  for (const file of candidates) {
    try { parts.push(`## ${file}\n${await readBoundedText(join(root, file), 12_000)}`); }
    catch { /* Optional convention file. */ }
  }
  return parts.join("\n\n").slice(0, 30_000);
}

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const value = await readFile(path);
  if (value.includes(0)) throw new Error(`Binary file requires manual review: ${path}`);
  return value.subarray(0, maxBytes).toString("utf8");
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: safeEnvironment() });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return { stdout, stderr };
}

async function runValidation(command: string, cwd: string) {
  const process = Bun.spawn(["bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe", env: safeEnvironment() });
  const timeout = setTimeout(() => process.kill(), 10 * 60_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  clearTimeout(timeout);
  return { command, exit_code: exitCode, output: `${stdout}\n${stderr}`.trim().slice(-20_000) };
}

function safeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL"]
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function parseJson(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); }
  catch { throw new Error("Member returned invalid JSON for development workflow"); }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
