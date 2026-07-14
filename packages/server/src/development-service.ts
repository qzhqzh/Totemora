import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { AgentConfig, LocalConfigSet, ProviderRegistry } from "@totemora/core";

import type { SettlementStore, Workplace, WorkplacePolicy } from "./settlement-store";
import { SkillGovernanceStore } from "./skill-governance-store";
import { OpenCodeCorrectionTool, type OpenCodeCorrectionResult } from "./opencode-correction-tool";
import { ToolAssetRegistry } from "./tool-asset-registry";

export interface DevelopmentProposal {
  id: string;
  status: "awaiting_approval" | "executing" | "awaiting_remote_approval" | "publishing" | "awaiting_merge_approval" | "merging" | "changes_requested" | "completed" | "failed";
  mode: "commit" | "pull_request" | "merge";
  issue_mode: "auto" | "none";
  workplace_id: string;
  workplace_name: string;
  goal: string;
  created_at: string;
  updated_at: string;
  snapshot_hash: string;
  policy_version: number;
  chief_member_id: string;
  specialist_member_id: string;
  assignment_reason: string;
  skill: { id: string; version: number };
  git_context: {
    branch: string;
    has_develop: boolean;
    unpushed_commits: number;
    stash_count: number;
  };
  files: string[];
  summary: string;
  commit_message: string;
  risk: string;
  validation_commands: string[];
  experience_used: string[];
  skill_improvement?: string;
  self_check: { outcome: "accepted" | "rejected"; rationale: string; issues: string[] };
  chief_acceptance: { outcome: "accepted" | "rejected"; rationale: string; issues: string[] };
  remote_plan?: {
    target_branch: string;
    branch_name: string;
    issue_title?: string;
    issue_body?: string;
    pr_title: string;
    pr_body: string;
  };
  issue_number?: number;
  issue_url?: string;
  pr_number?: number;
  pr_url?: string;
  pr_review?: { outcome: "accepted" | "changes_requested"; rationale: string; issues: string[] };
  chief_report?: { summary: string; acceptance: "passed" | "failed"; evidence: string[] };
  correction?: OpenCodeCorrectionResult;
  activities: Array<{ phase: string; message: string; at: string }>;
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
  branch: string;
  branches: string;
  unpushed: string;
  stash: string;
}

const GIT_COMMIT_SPECIALIST_ID = "deepseek_git_steward";
const GIT_CHANGE_SKILL_VERSION = 3;

interface SpecialistOutput {
  summary: string;
  commit_message: string;
  files: string[];
  risk: string;
  validation_commands: string[];
  experience_used: string[];
  skill_improvement?: string;
  self_check: { outcome: "accepted" | "rejected"; rationale: string; issues: string[] };
  remote_plan?: {
    target_branch: string;
    branch_name: string;
    issue_title?: string;
    issue_body?: string;
    pr_title: string;
    pr_body: string;
  };
}

type ExternalCommandRunner = (cwd: string, command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export class DevelopmentCommitService {
  private readonly proposalsDir: string;
  private readonly experienceFile: string;
  private readonly skillStore: SkillGovernanceStore;
  private readonly assetRegistry: ToolAssetRegistry;

  constructor(
    private readonly config: LocalConfigSet,
    private readonly providers: ProviderRegistry,
    private readonly settlement: SettlementStore,
    dataDir: string,
    private readonly projectRoot: string,
    private readonly externalCommand: ExternalCommandRunner = runExternalCommand,
    private readonly correctionTool = new OpenCodeCorrectionTool(),
  ) {
    this.proposalsDir = resolve(dataDir, "development", "proposals");
    this.experienceFile = resolve(dataDir, "member-experience", `${GIT_COMMIT_SPECIALIST_ID}.json`);
    this.skillStore = new SkillGovernanceStore(dataDir, "git-change-management", GIT_CHANGE_SKILL_VERSION);
    this.assetRegistry = new ToolAssetRegistry(projectRoot, dataDir);
  }

  async prepare(
    workplaceId: string,
    goal: string,
    options: { mode?: "commit" | "pull_request" | "merge"; issue_mode?: "auto" | "none" } = {},
  ): Promise<DevelopmentProposal> {
    const workplace = await this.getWorkplace(workplaceId);
    const policy = requirePolicy(workplace);
    const snapshot = await collectGitSnapshot(workplace.path, policy);
    const chief = requireMember(this.config, this.config.tribe.tribe.chief ?? "deepseek_reasoner");
    const mode = options.mode ?? "commit";
    const issueMode = options.issue_mode ?? (mode === "commit" ? "none" : "auto");
    const candidates = this.config.agents.agents.filter((member) =>
      !["inactive", "retired"].includes(member.status ?? "active")
      && (member.skills ?? []).includes("git-flow-safety"),
    );
    if (!candidates.length) throw new Error("No available tribe member has the git-flow-safety capability");
    const assignment = candidates.length === 1
      ? {
          member_id: candidates[0]!.id,
          assignment_reason: `Chief 路由器发现 ${candidates[0]!.name ?? candidates[0]!.id} 是唯一具备 git-flow-safety 的可用成员`,
          instruction: `接管目标“${goal}”，按 Workplace Policy 完成 ${mode} 流程并向 Chief 汇报证据`,
        }
      : await this.callJson(chief, [
          "你是 Totemora Chief。请从候选成员中选择一名 Git Flow 负责人，并包装清晰工作包。",
          `目标：${goal}`,
          `模式：${mode}；Issue：${issueMode}`,
          `候选：${JSON.stringify(candidates.map((member) => ({ id: member.id, profile: member.profile, skills: member.skills })))}`,
          `Policy：${JSON.stringify(policy)}`,
          "只输出 JSON：{member_id,assignment_reason,instruction}。",
        ].join("\n")) as { member_id?: string; assignment_reason?: string; instruction?: string };
    const specialist = candidates.find((member) => member.id === assignment.member_id);
    if (!specialist || !assignment.assignment_reason || !assignment.instruction) {
      throw new Error("Chief did not assign the Git Flow task to an eligible specialist");
    }
    await this.assetRegistry.assertCanUse(specialist, "git-flow-engine", "plan");
    const baseSkill = await readFile(resolve(this.projectRoot, "skills/git-change-management/SKILL.md"), "utf8");
    const skill = await this.skillStore.getActive(baseSkill);
    const experiences = await this.loadExperiences();

    const specialistPrompt = [
      specialist.persona ?? "",
      `Skill v${skill.version}：\n${skill.content}`,
      `最近已验证经验：${JSON.stringify(experiences.slice(-5))}`,
      `Chief 工作包：${assignment.instruction}`,
      `目标模式：${mode}；Issue 模式：${issueMode}`,
      `Workplace Policy：${JSON.stringify(policy)}`,
      `Commit message 硬约束：type(scope 可选): subject；type 只能是 ${policy.allowed_commit_types.join(", ")}；scope 只能含小写字母、数字、点、下划线、斜线或连字符；subject 为 1-72 个字符。`,
      `Git status：\n${snapshot.status}`,
      `Git Flow 上下文：当前分支 ${snapshot.branch}\n所有分支：\n${snapshot.branches}\n未推送 Commit：\n${snapshot.unpushed || "无"}\nstash：\n${snapshot.stash || "无"}`,
      `Git diff 与未跟踪文件摘要：\n${snapshot.diff}`,
      `项目规范文件：\n${snapshot.conventions}`,
      "只按 Skill 输出 JSON。不要声称测试已执行。",
    ].join("\n");
    let specialistOutput: SpecialistOutput | undefined;
    let validationFeedback = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const candidate = await this.callJson(specialist, `${specialistPrompt}${validationFeedback}`, 8_000) as SpecialistOutput;
      try {
        validateSpecialistOutput(
          candidate,
          snapshot.files,
          policy,
          new Set(experiences.map((item) => String(item.id ?? ""))),
          mode,
        );
        specialistOutput = candidate;
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        validationFeedback = [
          "\n上一次 JSON 未通过确定性校验。请修正后重新输出完整 JSON，不要解释。",
          `校验错误：${error instanceof Error ? error.message : String(error)}`,
          `上一次输出：${JSON.stringify(candidate)}`,
        ].join("\n");
      }
    }
    if (!specialistOutput) throw new Error("Git Flow specialist did not produce a valid plan");
    const chiefAcceptance = await this.callJson(chief, [
      "你是 Totemora Chief。验收 Git Flow 专员的计划，不替代专员重复工作。根据真实 Diff、Policy、自检和计划判断能否交给用户批准。",
      `目标：${goal}`,
      `Git status（完整）：\n${snapshot.status}`,
      `本次工作树文件清单（完整）：${JSON.stringify(snapshot.files)}`,
      `真实 Diff（最多 60000 字节，缺少某文件内容只代表预览截断；文件是否修改以 status 和完整清单为准）：\n${snapshot.diff}`,
      `Policy：${JSON.stringify(policy)}`,
      `专员汇报：${JSON.stringify(specialistOutput)}`,
      '只输出严格 JSON，例如 {"outcome":"accepted","rationale":"...","issues":[]}，不要输出解释或 Markdown。',
    ].join("\n")) as DevelopmentProposal["chief_acceptance"];
    validateAcceptance(chiefAcceptance, "Chief");

    const now = new Date().toISOString();
    const proposal: DevelopmentProposal = {
      id: crypto.randomUUID(),
      status: specialistOutput.self_check.outcome === "accepted" && chiefAcceptance.outcome === "accepted"
        ? "awaiting_approval"
        : "changes_requested",
      mode,
      issue_mode: issueMode,
      workplace_id: workplace.id,
      workplace_name: workplace.name,
      goal,
      created_at: now,
      updated_at: now,
      snapshot_hash: snapshot.hash,
      policy_version: policy.version,
      chief_member_id: chief.id,
      specialist_member_id: specialist.id,
      assignment_reason: assignment.assignment_reason,
      skill: { id: "git-change-management", version: skill.version },
      git_context: {
        branch: snapshot.branch,
        has_develop: /(^|[\s/])develop$/m.test(snapshot.branches),
        unpushed_commits: countLines(snapshot.unpushed),
        stash_count: countLines(snapshot.stash),
      },
      files: specialistOutput.files,
      summary: specialistOutput.summary,
      commit_message: specialistOutput.commit_message,
      risk: specialistOutput.risk,
      validation_commands: specialistOutput.validation_commands,
      experience_used: specialistOutput.experience_used,
      skill_improvement: specialistOutput.skill_improvement,
      self_check: specialistOutput.self_check,
      chief_acceptance: chiefAcceptance,
      remote_plan: specialistOutput.remote_plan,
      activities: [
        { phase: "assigned", message: assignment.assignment_reason, at: now },
        { phase: "planned", message: `${specialist.name ?? specialist.id} 已完成计划与自检`, at: now },
        { phase: chiefAcceptance.outcome === "accepted" ? "chief_accepted" : "changes_requested", message: chiefAcceptance.rationale, at: now },
      ],
    };
    await this.saveProposal(proposal);
    await this.recordAssetUse(
      proposal,
      "git-flow-engine",
      "plan",
      proposal.status === "awaiting_approval" ? "completed" : "failed",
      `Snapshot ${proposal.snapshot_hash}；专员=${proposal.self_check.outcome}；Chief=${proposal.chief_acceptance.outcome}`,
    );
    return proposal;
  }

  async approve(proposalId: string): Promise<DevelopmentProposal> {
    const proposal = await this.getProposal(proposalId);
    if (proposal.status !== "awaiting_approval") throw new Error(`Proposal cannot execute from status ${proposal.status}`);
    if (proposal.self_check.outcome !== "accepted" || proposal.chief_acceptance.outcome !== "accepted") {
      throw new Error("Git Flow plan was not accepted by the specialist and Chief");
    }
    const workplace = await this.getWorkplace(proposal.workplace_id);
    const policy = requirePolicy(workplace);
    if (policy.version !== proposal.policy_version) throw new Error("Workplace Policy changed; prepare a new proposal");
    const snapshot = await collectGitSnapshot(workplace.path, policy);
    if (snapshot.hash !== proposal.snapshot_hash) throw new Error("Git working tree changed after approval proposal; prepare again");

    proposal.status = "executing";
    proposal.updated_at = new Date().toISOString();
    await this.saveProposal(proposal);
    try {
      const specialist = requireMember(this.config, proposal.specialist_member_id);
      await this.assetRegistry.assertCanUse(specialist, "git-flow-engine", "execute_local");
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
      if (proposal.mode !== "commit" && proposal.remote_plan) {
        const currentBranch = (await git(workplace.path, ["branch", "--show-current"])).stdout.trim();
        if (currentBranch === proposal.remote_plan.target_branch) {
          await git(workplace.path, ["checkout", "-b", proposal.remote_plan.branch_name]);
          proposal.git_context.branch = proposal.remote_plan.branch_name;
          recordActivity(proposal, "branch_created", `已创建工作分支 ${proposal.remote_plan.branch_name}`);
        } else if (currentBranch !== proposal.remote_plan.branch_name) {
          throw new Error(`Current branch ${currentBranch} does not match approved branch ${proposal.remote_plan.branch_name}`);
        }
      }
      await git(workplace.path, ["add", "--", ...proposal.files]);
      const staged = await git(workplace.path, ["diff", "--cached", "--name-only"]);
      const stagedFiles = staged.stdout.trim().split("\n").filter(Boolean).sort();
      if (JSON.stringify(stagedFiles) !== JSON.stringify([...proposal.files].sort())) {
        throw new Error("Staged files differ from approved proposal");
      }
      await git(workplace.path, ["commit", "-m", proposal.commit_message]);
      proposal.commit_sha = (await git(workplace.path, ["rev-parse", "HEAD"])).stdout.trim();
      proposal.status = proposal.mode === "commit" ? "completed" : "awaiting_remote_approval";
      proposal.updated_at = new Date().toISOString();
      recordActivity(proposal, "committed", `已创建本地 Commit ${proposal.commit_sha}`);
      await this.saveProposal(proposal);
      await this.recordAssetUse(proposal, "git-flow-engine", "execute_local", "completed", `Commit ${proposal.commit_sha}`);
      if (proposal.status === "completed") await this.recordExperience(proposal);
      if (proposal.skill_improvement && proposal.commit_sha) {
        await this.skillStore.propose(proposal.skill_improvement, {
          development_proposal_id: proposal.id,
          commit_sha: proposal.commit_sha,
        });
      }
      return proposal;
    } catch (error) {
      await git(workplace.path, ["reset"]).catch(() => undefined);
      const failedValidation = proposal.validation_results?.find((result) => result.exit_code !== 0);
      if (failedValidation && policy.git_flow?.allow_opencode_fix) {
        try {
          const specialist = requireMember(this.config, proposal.specialist_member_id);
          await this.assetRegistry.assertCanUse(specialist, "opencode-correction", "correct_code");
          proposal.correction = await this.correctionTool.correct({
            cwd: workplace.path,
            goal: proposal.goal,
            files: proposal.files,
            validation_commands: proposal.validation_commands,
            failure: `${failedValidation.command}\n${failedValidation.output}`,
          });
          proposal.status = "changes_requested";
          proposal.error = "OpenCode 已按受限权限尝试修复；工作树已变化，必须由专员和 Chief 重新审阅后才能继续";
          proposal.updated_at = new Date().toISOString();
          recordActivity(proposal, "opencode_correction", proposal.error);
          await this.saveProposal(proposal);
          await this.recordAssetUse(proposal, "opencode-correction", "correct_code", "completed", proposal.correction.output.slice(-2_000));
          return proposal;
        } catch (correctionError) {
          recordActivity(proposal, "opencode_failed", correctionError instanceof Error ? correctionError.message : String(correctionError));
          await this.recordAssetUse(proposal, "opencode-correction", "correct_code", "failed", correctionError instanceof Error ? correctionError.message : String(correctionError));
        }
      }
      proposal.status = "failed";
      proposal.error = error instanceof Error ? error.message : String(error);
      proposal.updated_at = new Date().toISOString();
      await this.saveProposal(proposal);
      await this.recordAssetUse(proposal, "git-flow-engine", "execute_local", "failed", proposal.error);
      return proposal;
    }
  }

  async publish(proposalId: string): Promise<DevelopmentProposal> {
    const proposal = await this.getProposal(proposalId);
    if (proposal.status !== "awaiting_remote_approval") {
      throw new Error(`Git Flow remote stage cannot execute from ${proposal.status}`);
    }
    const workplace = await this.getWorkplace(proposal.workplace_id);
    const policy = requirePolicy(workplace);
    const remotePolicy = requireRemotePolicy(policy);
    if (!proposal.remote_plan || !proposal.commit_sha) throw new Error("Git Flow remote plan is incomplete");
    if (!remotePolicy.allow_push || !remotePolicy.allow_pull_request) {
      throw new Error("Workplace Policy does not allow push and pull request creation");
    }
    if (proposal.issue_mode === "auto" && !remotePolicy.allow_issue) {
      throw new Error("Workplace Policy does not allow issue creation");
    }
    proposal.status = "publishing";
    proposal.error = undefined;
    proposal.updated_at = new Date().toISOString();
    await this.saveProposal(proposal);
    try {
      const specialist = requireMember(this.config, proposal.specialist_member_id);
      await this.assetRegistry.assertCanUse(specialist, "git-flow-engine", "execute_remote");
      const branch = (await git(workplace.path, ["branch", "--show-current"])).stdout.trim();
      if (branch !== proposal.git_context.branch) throw new Error("Current branch changed after local approval");
      if ((await git(workplace.path, ["rev-parse", "HEAD"])).stdout.trim() !== proposal.commit_sha) {
        throw new Error("HEAD changed after the approved local Commit");
      }
      if (proposal.issue_mode === "auto" && !proposal.issue_number) {
        const issue = await this.externalCommand(workplace.path, "gh", [
          "issue", "create", "--title", proposal.remote_plan.issue_title!,
          "--body", proposal.remote_plan.issue_body!,
        ]);
        proposal.issue_url = lastNonEmptyLine(issue.stdout);
        proposal.issue_number = parseGitHubNumber(proposal.issue_url, "issues");
        recordActivity(proposal, "issue_created", `Issue #${proposal.issue_number} 已创建`);
        await this.saveProposal(proposal);
      }
      const pushTransport = await this.pushBranch(workplace.path, branch);
      recordActivity(proposal, "pushed", `分支 ${branch} 已通过 ${pushTransport} 推送到 origin`);
      await this.saveProposal(proposal);
      if (!proposal.pr_number) {
        const closing = proposal.issue_number ? `\n\nCloses #${proposal.issue_number}` : "";
        const pullRequest = await this.externalCommand(workplace.path, "gh", [
          "pr", "create", "--base", proposal.remote_plan.target_branch,
          "--head", branch, "--title", proposal.remote_plan.pr_title,
          "--body", `${proposal.remote_plan.pr_body}${closing}`,
        ]);
        proposal.pr_url = lastNonEmptyLine(pullRequest.stdout);
        proposal.pr_number = parseGitHubNumber(proposal.pr_url, "pull");
        recordActivity(proposal, "pr_created", `PR #${proposal.pr_number} 已创建`);
        await this.saveProposal(proposal);
      }
      const prDiff = await this.externalCommand(workplace.path, "gh", ["pr", "diff", String(proposal.pr_number)]);
      await this.assetRegistry.assertCanUse(specialist, "git-flow-engine", "review_pr");
      proposal.pr_review = await this.callJson(specialist, [
        "你是负责该流程的 Git 流程专员。代码由其他成员或用户编写；现在评审真实 PR Diff，检查目标、范围、风险和验证证据。",
        `目标：${proposal.goal}`,
        `Policy：${JSON.stringify(policy)}`,
        `本地验证：${JSON.stringify(proposal.validation_results)}`,
        `PR Diff：\n${prDiff.stdout.slice(0, 60_000)}`,
        '只输出严格 JSON，例如 {"outcome":"accepted","rationale":"...","issues":[]}，不要输出解释或 Markdown。',
      ].join("\n")) as DevelopmentProposal["pr_review"];
      validatePrReview(proposal.pr_review);
      const chief = requireMember(this.config, proposal.chief_member_id);
      proposal.chief_acceptance = await this.callJson(chief, [
        "你是 Totemora Chief。根据 Git 流程专员的真实 PR 评审和执行证据决定是否验收该阶段。",
        `目标：${proposal.goal}`,
        `PR：${proposal.pr_url}`,
        `专员评审：${JSON.stringify(proposal.pr_review)}`,
        `验证：${JSON.stringify(proposal.validation_results)}`,
        '只输出严格 JSON，例如 {"outcome":"accepted","rationale":"...","issues":[]}，不要输出解释或 Markdown。',
      ].join("\n")) as DevelopmentProposal["chief_acceptance"];
      validateAcceptance(proposal.chief_acceptance, "Chief");
      if (proposal.pr_review.outcome === "changes_requested" || proposal.chief_acceptance.outcome === "rejected") {
        proposal.status = "changes_requested";
        recordActivity(proposal, "changes_requested", proposal.pr_review.rationale);
      } else if (proposal.mode === "merge") {
        proposal.status = "awaiting_merge_approval";
        recordActivity(proposal, "merge_ready", "专员评审与 Chief 验收通过，等待 Merge 门禁");
      } else {
        proposal.status = "completed";
        recordActivity(proposal, "completed", "Pull Request 已创建并通过部落验收");
        await this.recordExperience(proposal);
      }
      proposal.updated_at = new Date().toISOString();
      await this.saveProposal(proposal);
      await this.recordAssetUse(proposal, "git-flow-engine", "execute_remote", "completed", `PR ${proposal.pr_url ?? "unknown"}`);
      await this.recordAssetUse(proposal, "git-flow-engine", "review_pr", "completed", proposal.pr_review.rationale);
      return proposal;
    } catch (error) {
      proposal.status = "awaiting_remote_approval";
      proposal.error = error instanceof Error ? error.message : String(error);
      proposal.updated_at = new Date().toISOString();
      recordActivity(proposal, "remote_failed", proposal.error);
      await this.saveProposal(proposal);
      await this.recordAssetUse(proposal, "git-flow-engine", "execute_remote", "failed", proposal.error);
      return proposal;
    }
  }

  async merge(proposalId: string): Promise<DevelopmentProposal> {
    const proposal = await this.getProposal(proposalId);
    if (proposal.status !== "awaiting_merge_approval") {
      throw new Error(`Git Flow merge stage cannot execute from ${proposal.status}`);
    }
    const workplace = await this.getWorkplace(proposal.workplace_id);
    const policy = requirePolicy(workplace);
    const remotePolicy = requireRemotePolicy(policy);
    if (!remotePolicy.allow_merge) throw new Error("Workplace Policy does not allow merge");
    if (!proposal.pr_number || !proposal.remote_plan || proposal.pr_review?.outcome !== "accepted") {
      throw new Error("Pull Request has not passed specialist review");
    }
    proposal.status = "merging";
    proposal.error = undefined;
    proposal.updated_at = new Date().toISOString();
    await this.saveProposal(proposal);
    try {
      const specialist = requireMember(this.config, proposal.specialist_member_id);
      await this.assetRegistry.assertCanUse(specialist, "git-flow-engine", "execute_merge");
      const state = JSON.parse((await this.externalCommand(workplace.path, "gh", [
        "pr", "view", String(proposal.pr_number), "--json", "state,isDraft,mergeStateStatus,url",
      ])).stdout) as { state: string; isDraft: boolean; mergeStateStatus: string; url: string };
      if (state.state !== "MERGED" && (state.isDraft || state.state !== "OPEN" || ["BLOCKED", "DIRTY"].includes(state.mergeStateStatus))) {
        throw new Error(`Pull Request is not mergeable: ${JSON.stringify(state)}`);
      }
      if (state.state !== "MERGED") {
        await this.externalCommand(workplace.path, "gh", ["pr", "merge", String(proposal.pr_number), "--squash", "--delete-branch"]);
      }
      await git(workplace.path, ["checkout", proposal.remote_plan.target_branch]);
      await git(workplace.path, ["pull", "--ff-only", "origin", proposal.remote_plan.target_branch]);
      await git(workplace.path, ["fetch", "--prune", "origin"]);
      const merged = JSON.parse((await this.externalCommand(workplace.path, "gh", [
        "pr", "view", String(proposal.pr_number), "--json", "state,mergedAt,mergeCommit,url",
      ])).stdout) as { state: string; mergedAt?: string; mergeCommit?: { oid?: string }; url: string };
      if (merged.state !== "MERGED") throw new Error("GitHub did not report the Pull Request as merged");
      const chief = requireMember(this.config, proposal.chief_member_id);
      proposal.chief_report = await this.callJson(chief, [
        "你是 Totemora Chief。Git 流程专员已完成工作，请根据真实结果向调用方形成最终验收报告。",
        `目标：${proposal.goal}`,
        `Issue：${proposal.issue_url ?? "无"}`,
        `PR：${proposal.pr_url}`,
        `Merge：${JSON.stringify(merged)}`,
        `验证：${JSON.stringify(proposal.validation_results)}`,
        '只输出严格 JSON，例如 {"summary":"...","acceptance":"passed","evidence":["..."]}，不要输出解释或 Markdown。',
      ].join("\n")) as DevelopmentProposal["chief_report"];
      validateChiefReport(proposal.chief_report);
      proposal.status = proposal.chief_report.acceptance === "passed" ? "completed" : "failed";
      proposal.updated_at = new Date().toISOString();
      recordActivity(proposal, "merged", `PR #${proposal.pr_number} 已合并到 ${proposal.remote_plan.target_branch}`);
      await this.saveProposal(proposal);
      await this.recordAssetUse(proposal, "git-flow-engine", "execute_merge", "completed", `PR ${proposal.pr_url ?? proposal.pr_number} merged to ${proposal.remote_plan.target_branch}`);
      if (proposal.status === "completed") await this.recordExperience(proposal);
      return proposal;
    } catch (error) {
      proposal.status = "awaiting_merge_approval";
      proposal.error = error instanceof Error ? error.message : String(error);
      proposal.updated_at = new Date().toISOString();
      recordActivity(proposal, "merge_failed", proposal.error);
      await this.saveProposal(proposal);
      await this.recordAssetUse(proposal, "git-flow-engine", "execute_merge", "failed", proposal.error);
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

  private async callJson(member: AgentConfig, prompt: string, maxTokens = 4_000): Promise<unknown> {
    const response = await this.providers.get(member.provider).generate({
      memberId: member.id,
      model: member.model,
      messages: [
        { role: "system", content: member.persona ?? `你是部落成员 ${member.id}` },
        { role: "user", content: prompt },
      ],
      responseFormat: "json",
      maxTokens,
    });
    return parseJson(response.content, member.id);
  }

  private async saveProposal(proposal: DevelopmentProposal): Promise<void> {
    await mkdir(this.proposalsDir, { recursive: true });
    await atomicWrite(join(this.proposalsDir, `${proposal.id}.json`), proposal);
  }

  private async pushBranch(cwd: string, branch: string): Promise<"configured origin" | "GitHub HTTPS fallback"> {
    try {
      await git(cwd, ["push", "-u", "origin", branch]);
      return "configured origin";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/(port 22|Could not read from remote repository|ssh:)/i.test(message)) throw error;
      const repository = JSON.parse((await this.externalCommand(cwd, "gh", ["repo", "view", "--json", "url"])).stdout) as { url?: string };
      if (!repository.url || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.url)) {
        throw new Error("GitHub HTTPS fallback could not resolve a safe repository URL", { cause: error });
      }
      await git(cwd, [
        "-c", "credential.helper=!gh auth git-credential",
        "push", `${repository.url}.git`, branch,
      ]);
      return "GitHub HTTPS fallback";
    }
  }

  private async recordAssetUse(
    proposal: DevelopmentProposal,
    assetId: string,
    action: string,
    outcome: "completed" | "failed",
    evidence: string,
  ): Promise<void> {
    try {
      await this.assetRegistry.recordUse({
        asset_id: assetId,
        member_id: proposal.specialist_member_id,
        workflow_id: proposal.id,
        action,
        outcome,
        evidence,
      });
    } catch (error) {
      recordActivity(proposal, "asset_audit_failed", error instanceof Error ? error.message : String(error));
      await this.saveProposal(proposal).catch(() => undefined);
    }
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
      branch: proposal.git_context.branch,
      skill: proposal.skill,
      summary: proposal.summary,
      validation_commands: proposal.validation_commands,
      self_check_outcome: proposal.self_check.outcome,
      chief_acceptance: proposal.chief_acceptance.outcome,
      commit_sha: proposal.commit_sha,
      issue_url: proposal.issue_url,
      pr_url: proposal.pr_url,
      mode: proposal.mode,
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
  const branch = (await git(root, ["branch", "--show-current"])).stdout.trim();
  if (!branch) throw new Error("Development commit workflow requires a named Git branch");
  const branches = (await git(root, ["branch", "--all", "--no-color"])).stdout.trim();
  const unpushed = (await gitOptional(root, ["log", "@{upstream}..HEAD", "--oneline"])).trim();
  const stash = (await git(root, ["stash", "list"])).stdout.trim();
  let diff = (await git(root, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", ...tracked])).stdout;
  for (const file of untracked) {
    const content = await readBoundedText(join(root, file), 8_000);
    diff += `\n--- /dev/null\n+++ b/${file}\n[untracked preview]\n${content}`;
  }
  diff = diff.slice(0, 60_000);
  const conventions = await readConventionFiles(root);
  const hash = createHash("sha256");
  hash.update(status);
  hash.update(JSON.stringify({ policy_version: policy.version, files, branch, branches, unpushed, stash }));
  for (const file of files) {
    try { hash.update(await readFile(join(root, file))); }
    catch { hash.update("[deleted]"); }
  }
  return { hash: hash.digest("hex"), files, status, diff, conventions, branch, branches, unpushed, stash };
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
  mode: DevelopmentProposal["mode"],
): void {
  if (!output || !output.summary || !output.commit_message || !output.risk || !Array.isArray(output.files) || !Array.isArray(output.validation_commands) || !Array.isArray(output.experience_used)) {
    throw new Error("Commit specialist returned an invalid proposal");
  }
  validateAcceptance(output.self_check, "Git Flow specialist self-check");
  if (output.self_check.outcome !== "accepted") throw new Error("Git Flow specialist rejected its own plan");
  if (mode !== "commit" && (!output.remote_plan?.target_branch || !output.remote_plan.branch_name || !output.remote_plan.pr_title || !output.remote_plan.pr_body)) {
    throw new Error("Git Flow specialist returned an incomplete remote plan");
  }
  if (mode !== "commit" && output.remote_plan?.target_branch !== policy.git_flow?.target_branch) {
    throw new Error("Git Flow specialist selected a target branch outside Workplace Policy");
  }
  if (output.remote_plan?.branch_name && !/^(feat|fix|test|chore|docs|refactor|codex)\/[a-z0-9._/-]+$/.test(output.remote_plan.branch_name)) {
    throw new Error("Git Flow specialist selected an invalid working branch name");
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
    throw new Error(`Commit message ${JSON.stringify(output.commit_message)} does not satisfy Policy; expected type(scope optional): subject with type in [${policy.allowed_commit_types.join(", ")}] and a 1-72 character subject`);
  }
  for (const file of output.files) assertSafePath(file, policy);
}

function validateAcceptance(
  value: { outcome: "accepted" | "rejected"; rationale: string; issues: string[] } | undefined,
  owner: string,
): asserts value is { outcome: "accepted" | "rejected"; rationale: string; issues: string[] } {
  if (!value || !["accepted", "rejected"].includes(value.outcome) || !value.rationale || !Array.isArray(value.issues)) {
    throw new Error(`${owner} returned an invalid acceptance`);
  }
}

function validatePrReview(
  value: DevelopmentProposal["pr_review"],
): asserts value is NonNullable<DevelopmentProposal["pr_review"]> {
  if (!value || !["accepted", "changes_requested"].includes(value.outcome) || !value.rationale || !Array.isArray(value.issues)) {
    throw new Error("Git Flow specialist returned an invalid PR review");
  }
}

function validateChiefReport(
  value: DevelopmentProposal["chief_report"],
): asserts value is NonNullable<DevelopmentProposal["chief_report"]> {
  if (!value || !value.summary || !["passed", "failed"].includes(value.acceptance) || !Array.isArray(value.evidence)) {
    throw new Error("Chief returned an invalid final Git Flow report");
  }
}

function requireRemotePolicy(policy: WorkplacePolicy) {
  if (!policy.git_flow || policy.git_flow.remote_provider !== "github") {
    throw new Error("Workplace Policy has not enabled GitHub remote operations");
  }
  return policy.git_flow;
}

function recordActivity(proposal: DevelopmentProposal, phase: string, message: string): void {
  proposal.activities.push({ phase, message, at: new Date().toISOString() });
}

function lastNonEmptyLine(value: string): string {
  const line = value.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("GitHub CLI returned no resource URL");
  return line;
}

function parseGitHubNumber(url: string, segment: "issues" | "pull"): number {
  const match = url.match(new RegExp(`/${segment}/(\\d+)(?:$|[?#])`));
  if (!match) throw new Error(`Cannot parse GitHub ${segment} number from ${url}`);
  return Number(match[1]);
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

async function runExternalCommand(cwd: string, command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const process = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: safeEnvironment() });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command} ${args[0] ?? ""} failed: ${stderr.trim() || stdout.trim()}`);
  return { stdout, stderr };
}

async function gitOptional(cwd: string, args: string[]): Promise<string> {
  try { return (await git(cwd, args)).stdout; }
  catch { return ""; }
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

function parseJson(content: string, memberId: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); }
  catch {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try { return JSON.parse(fenced.trim()); } catch { /* Try balanced extraction. */ }
    }
    for (const candidate of balancedJsonObjects(content)) {
      try { return JSON.parse(candidate); } catch { /* Keep scanning. */ }
    }
    const preview = content.replace(/\s+/g, " ").trim().slice(0, 300);
    throw new Error(`Member ${memberId} returned invalid JSON for development workflow: ${preview || "empty response"}`);
  }
}

function balancedJsonObjects(content: string): string[] {
  const values: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (start < 0) {
      if (character === "{") { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        values.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return values;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countLines(value: string): number {
  return value.trim() ? value.trim().split("\n").length : 0;
}
