import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentConfig, LocalConfigSet, ModelUsage, ProviderRegistry } from "@totemora/core";

import type { SettlementStore, Workplace, WorkplacePolicy } from "./settlement-store";
import { SkillGovernanceStore } from "./skill-governance-store";
import { OpenCodeCorrectionTool, type OpenCodeCorrectionResult } from "./opencode-correction-tool";
import { ToolAssetRegistry } from "./tool-asset-registry";
import { StateDatabase } from "./state-database";
import { MemberStateStore } from "./member-state-store";
import { SkillCommissionService } from "./skill-commission-service";
import { GIT_FLOW_SKILL_ID, GIT_FLOW_SKILL_VERSION } from "./git-flow-skill";
import {
  parseMemberJson,
  type SpecialistOutput,
  validateAcceptance,
  validateChiefReport,
  validatePrReview,
  validateSpecialistOutput,
} from "./development-contracts";
import {
  collectGitSnapshot,
  countLines,
  type ExternalCommandRunner,
  git,
  runExternalCommand,
  runValidation,
} from "./development-git-client";
import { DevelopmentGitHubClient } from "./development-github-client";

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
  skill: { id: string; version: number; digest?: string; package_digest?: string; commission_id?: string };
  evaluation: {
    accepted: boolean;
    calls: number;
    total_tokens: number;
    usage_status: "measured" | "partial" | "unknown";
    latency_ms: number;
  };
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
  issue_creation_unknown?: boolean;
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

const GIT_COMMIT_SPECIALIST_ID = "deepseek_git_steward";

export class DevelopmentCommitService {
  private readonly proposalsDir: string;
  private readonly experienceFile: string;
  private readonly skillStore: SkillGovernanceStore;
  private readonly assetRegistry: ToolAssetRegistry;
  private readonly state: StateDatabase;
  private readonly memberState: MemberStateStore;
  private readonly skillCommissions: SkillCommissionService;
  private readonly github: DevelopmentGitHubClient;

  constructor(
    private readonly config: LocalConfigSet,
    private readonly providers: ProviderRegistry,
    private readonly settlement: SettlementStore,
    dataDir: string,
    private readonly projectRoot: string,
    externalCommand: ExternalCommandRunner = runExternalCommand,
    private readonly correctionTool = new OpenCodeCorrectionTool(),
  ) {
    this.proposalsDir = resolve(dataDir, "development", "proposals");
    this.experienceFile = resolve(dataDir, "member-experience", `${GIT_COMMIT_SPECIALIST_ID}.json`);
    this.skillStore = new SkillGovernanceStore(dataDir, GIT_FLOW_SKILL_ID, GIT_FLOW_SKILL_VERSION);
    this.assetRegistry = new ToolAssetRegistry(projectRoot, dataDir);
    this.state = StateDatabase.open(dataDir);
    this.memberState = new MemberStateStore(dataDir, config);
    this.skillCommissions = new SkillCommissionService(config, providers, dataDir);
    this.github = new DevelopmentGitHubClient(externalCommand);
    this.importLegacyState();
  }

  async prepare(
    workplaceId: string,
    goal: string,
    options: {
      mode?: "commit" | "pull_request" | "merge";
      issue_mode?: "auto" | "none";
      trial_commission_id?: string;
      specialist_member_id?: string;
    } = {},
  ): Promise<DevelopmentProposal> {
    const startedAt = performance.now();
    const usageRecords: Array<ModelUsage | undefined> = [];
    const recordUsage = (usage: ModelUsage | undefined) => usageRecords.push(usage);
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
    const pinnedSpecialist = options.specialist_member_id
      ? candidates.find((member) => member.id === options.specialist_member_id)
      : undefined;
    if (options.specialist_member_id && !pinnedSpecialist) {
      throw new Error("Pinned Git Flow specialist is unavailable or ineligible");
    }
    const assignment = pinnedSpecialist
      ? {
          member_id: pinnedSpecialist.id,
          assignment_reason: `Skill 试炼固定由 ${pinnedSpecialist.name ?? pinnedSpecialist.id} 运行基线与试用`,
          instruction: `在同一快照上接管目标“${goal}”，按 Workplace Policy 形成 ${mode} 流程计划并向 Chief 汇报证据`,
        }
      : candidates.length === 1
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
        ].join("\n"), 4_000, recordUsage) as { member_id?: string; assignment_reason?: string; instruction?: string };
    const specialist = candidates.find((member) => member.id === assignment.member_id);
    if (!specialist || !assignment.assignment_reason || !assignment.instruction) {
      throw new Error("Chief did not assign the Git Flow task to an eligible specialist");
    }
    await this.assetRegistry.assertCanUse(specialist, "git-flow-engine", "plan");
    const [skillInstructions, planContract] = await Promise.all([
      readFile(resolve(this.projectRoot, "skills", GIT_FLOW_SKILL_ID, "SKILL.md"), "utf8"),
      readFile(resolve(this.projectRoot, "skills", GIT_FLOW_SKILL_ID, "references/totemora-plan-contract.md"), "utf8"),
    ]);
    const baseSkill = `${skillInstructions.trim()}\n\n${planContract.trim()}\n`;
    const legacySkill = await this.skillStore.getActive(baseSkill);
    const candidateManagedSkill = options.trial_commission_id
      ? this.skillCommissions.trialPackage(options.trial_commission_id, specialist.id, "git.flow")
      : this.skillCommissions.activePackage(GIT_FLOW_SKILL_ID, specialist.id, "git.flow");
    if (options.trial_commission_id && candidateManagedSkill?.base_version !== GIT_FLOW_SKILL_VERSION) {
      throw new Error(`Skill trial package targets stale base v${candidateManagedSkill?.base_version ?? "unknown"}; recreate it for v${GIT_FLOW_SKILL_VERSION}`);
    }
    const managedSkill = candidateManagedSkill?.base_version === GIT_FLOW_SKILL_VERSION
      ? candidateManagedSkill
      : undefined;
    const skill = {
      version: Math.max(legacySkill.version, managedSkill?.version ?? 0),
      content: managedSkill
        ? `${legacySkill.content.trim()}\n\n## 已批准的对话式 Skill 包\n\n${managedSkill.skill_md.trim()}\n`
        : legacySkill.content,
      digest: createHash("sha256").update(managedSkill
        ? `${legacySkill.content.trim()}\n${managedSkill.digest}\n${managedSkill.skill_md.trim()}`
        : legacySkill.content).digest("hex"),
      commission_id: managedSkill?.commission_id,
    };
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
      const candidate = await this.callJson(specialist, `${specialistPrompt}${validationFeedback}`, 8_000, recordUsage) as SpecialistOutput;
      try {
        validateSpecialistOutput(
          candidate,
          snapshot.files,
          policy,
          new Set(experiences.map((item) => String(item.id ?? ""))),
          mode,
        );
        if (["main", "master"].includes(snapshot.branch)
          && (!candidate.remote_plan?.branch_name || candidate.remote_plan.target_branch !== snapshot.branch)) {
          throw new Error("Git Flow Skill requires a short-lived branch plan targeting the current main/master branch");
        }
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
    ].join("\n"), 4_000, recordUsage) as DevelopmentProposal["chief_acceptance"];
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
      skill: {
        id: GIT_FLOW_SKILL_ID, version: skill.version, digest: skill.digest,
        ...(managedSkill ? { package_digest: managedSkill.digest } : {}),
        ...(skill.commission_id ? { commission_id: skill.commission_id } : {}),
      },
      evaluation: summarizeEvaluationUsage(
        usageRecords,
        specialistOutput.self_check.outcome === "accepted" && chiefAcceptance.outcome === "accepted",
        performance.now() - startedAt,
      ),
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
      const currentBranch = (await git(workplace.path, ["branch", "--show-current"])).stdout.trim();
      if (["main", "master"].includes(currentBranch) && !proposal.remote_plan) {
        throw new Error("Git Flow Skill forbids committing directly on main/master; prepare a short-lived branch plan");
      }
      if (proposal.remote_plan) {
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
        const marker = `totemora-proposal-${proposal.id}`;
        const existing = await this.github.findIssueByMarker(workplace.path, marker);
        if (!existing && proposal.issue_creation_unknown) {
          throw new Error("GitHub Issue creation outcome is unknown; verify the repository and retry reconciliation later");
        }
        let issue = existing;
        if (!issue) {
          try {
            issue = await this.github.createIssue(
              workplace.path, proposal.remote_plan.issue_title!,
              `${proposal.remote_plan.issue_body!}\n\n<!-- ${marker} -->`,
            );
          } catch (error) {
            proposal.issue_creation_unknown = true;
            proposal.updated_at = new Date().toISOString();
            recordActivity(proposal, "issue_creation_unknown", "GitHub Issue 创建结果未知，禁止自动重放");
            await this.saveProposal(proposal);
            throw error;
          }
        }
        proposal.issue_url = issue.url;
        proposal.issue_number = issue.number;
        proposal.issue_creation_unknown = undefined;
        recordActivity(
          proposal,
          existing ? "issue_reused" : "issue_created",
          `Issue #${proposal.issue_number} 已${existing ? "调和复用" : "创建"}`,
        );
        await this.saveProposal(proposal);
      }
      const pushTransport = await this.github.pushBranch(workplace.path, branch);
      recordActivity(proposal, "pushed", `分支 ${branch} 已通过 ${pushTransport} 推送到 origin`);
      await this.saveProposal(proposal);
      if (!proposal.pr_number) {
        const closing = proposal.issue_number ? `\n\nCloses #${proposal.issue_number}` : "";
        const existing = await this.github.findOpenPullRequest(
          workplace.path, branch, proposal.remote_plan.target_branch,
        );
        if (existing) {
          proposal.pr_number = existing.number;
          proposal.pr_url = existing.url;
          await this.github.editPullRequest(
            workplace.path, existing.number, proposal.remote_plan.pr_title,
            `${proposal.remote_plan.pr_body}${closing}`,
          );
          recordActivity(proposal, "pr_reused", `PR #${proposal.pr_number} 已复用并更新说明`);
        } else {
          const pullRequest = await this.github.createPullRequest(workplace.path, {
            base: proposal.remote_plan.target_branch,
            head: branch,
            title: proposal.remote_plan.pr_title,
            body: `${proposal.remote_plan.pr_body}${closing}`,
          });
          proposal.pr_url = pullRequest.url;
          proposal.pr_number = pullRequest.number;
          recordActivity(proposal, "pr_created", `PR #${proposal.pr_number} 已创建`);
        }
        await this.saveProposal(proposal);
      }
      const prDiff = await this.github.pullRequestDiff(workplace.path, proposal.pr_number);
      const prFiles = await this.github.pullRequestFiles(workplace.path, proposal.pr_number);
      await this.assetRegistry.assertCanUse(specialist, "git-flow-engine", "review_pr");
      proposal.pr_review = await this.callJson(specialist, [
        "你是负责该流程的 Git 流程专员。代码由其他成员或用户编写；现在评审真实 PR Diff，检查目标、范围、风险和验证证据。",
        `目标：${proposal.goal}`,
        `Policy：${JSON.stringify(policy)}`,
        `本地验证：${JSON.stringify(proposal.validation_results)}`,
        `PR 完整文件清单：${JSON.stringify(prFiles)}`,
        `PR Diff（最多 60000 字节；缺少某文件内容只代表预览截断，范围以完整文件清单为准）：\n${prDiff.slice(0, 60_000)}`,
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
      const state = await this.github.pullRequestState(workplace.path, proposal.pr_number);
      if (state.state !== "MERGED" && (state.isDraft || state.state !== "OPEN" || ["BLOCKED", "DIRTY"].includes(state.mergeStateStatus))) {
        throw new Error(`Pull Request is not mergeable: ${JSON.stringify(state)}`);
      }
      if (state.state !== "MERGED") {
        await this.github.mergePullRequest(workplace.path, proposal.pr_number);
      }
      await git(workplace.path, ["checkout", proposal.remote_plan.target_branch]);
      const syncTransport = await this.github.syncTargetBranch(workplace.path, proposal.remote_plan.target_branch);
      const merged = await this.github.mergedPullRequest(workplace.path, proposal.pr_number);
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
      recordActivity(proposal, "merged", `PR #${proposal.pr_number} 已合并到 ${proposal.remote_plan.target_branch}，本地通过 ${syncTransport} 同步`);
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
    const proposal = this.state.listRecords<DevelopmentProposal>("development_proposals")
      .find((item) => item.id === id);
    if (!proposal) throw new Error(`Development proposal not found: ${id}`);
    return proposal;
  }

  async listProposals(): Promise<DevelopmentProposal[]> {
    return this.state.listRecords<DevelopmentProposal>("development_proposals")
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

  private async callJson(
    member: AgentConfig,
    prompt: string,
    maxTokens = 4_000,
    onUsage?: (usage: ModelUsage | undefined) => void,
  ): Promise<unknown> {
    const constitution = (await this.memberState.getDossier(member.id)).portrait.constitution;
    const response = await this.providers.get(member.provider).generate({
      memberId: member.id,
      model: member.model,
      messages: [
        { role: "system", content: [
          member.persona ?? `你是部落成员 ${member.id}`,
          `正式画像 v${constitution.version}：特质=${JSON.stringify(constitution.traits)}；表达=${JSON.stringify(constitution.communication_style)}；工作偏好=${JSON.stringify(constitution.working_preferences)}`,
        ].join("\n") },
        { role: "user", content: prompt },
      ],
      responseFormat: "json",
      maxTokens,
    });
    onUsage?.(response.usage);
    return parseMemberJson(response.content, member.id);
  }

  private async saveProposal(proposal: DevelopmentProposal): Promise<void> {
    this.state.putRecord("development_proposals", proposal.id, proposal, proposal.created_at, proposal.updated_at);
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
    return this.state.listRecords<Record<string, unknown>>(`member_experience:${GIT_COMMIT_SPECIALIST_ID}`);
  }

  private async recordExperience(proposal: DevelopmentProposal): Promise<void> {
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    const experience = {
      id, at,
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
    };
    this.state.db.transaction(() => {
      this.state.putRecord(`member_experience:${GIT_COMMIT_SPECIALIST_ID}`, id, experience, at, at);
      this.state.db.query(`
        INSERT OR IGNORE INTO member_events(
          id,member_id,kind,credit_type,credit_value,verified,source_type,source_id,summary,at
        ) VALUES(?,?,'success','task_outcome',1,1,'git_flow',?,?,?)
      `).run(
        crypto.randomUUID(), GIT_COMMIT_SPECIALIST_ID, proposal.id,
        `Git Flow 验收通过：${proposal.summary}`, at,
      );
    })();
  }

  private importLegacyState(): void {
    let files: string[];
    try { files = readdirSync(this.proposalsDir).filter((file) => file.endsWith(".json")); }
    catch { files = []; }
    for (const file of files) {
      const path = resolve(this.proposalsDir, file);
      this.state.importJsonFile<DevelopmentProposal>(
        path,
        (value) => [value as DevelopmentProposal],
        (proposal) => this.state.putRecord("development_proposals", proposal.id, proposal, proposal.created_at, proposal.updated_at),
      );
    }
    this.state.importJsonFile<Record<string, unknown>>(
      this.experienceFile,
      (value) => {
        if (!Array.isArray(value)) throw new Error("expected Git experience array");
        return value as Array<Record<string, unknown>>;
      },
      (experience) => {
        const experienceId = String(experience.id ?? crypto.randomUUID());
        const experienceAt = String(experience.at ?? new Date(0).toISOString());
        this.state.putRecord(`member_experience:${GIT_COMMIT_SPECIALIST_ID}`, experienceId, experience, experienceAt, experienceAt);
      },
    );
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

function summarizeEvaluationUsage(
  records: Array<ModelUsage | undefined>,
  accepted: boolean,
  latencyMs: number,
): DevelopmentProposal["evaluation"] {
  const measured = records.filter((usage): usage is ModelUsage => typeof usage?.totalTokens === "number");
  return {
    accepted,
    calls: records.length,
    total_tokens: measured.reduce((total, usage) => total + (usage.totalTokens ?? 0), 0),
    usage_status: measured.length === records.length && records.length > 0
      ? "measured"
      : measured.length > 0 ? "partial" : "unknown",
    latency_ms: Math.round(latencyMs),
  };
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
