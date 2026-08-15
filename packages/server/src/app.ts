import {
  FileRunStore,
  TribeRuntime,
  collectWorkspaceSnapshot,
  loadLocalConfig,
  validateLocalConfig,
  analyzeTaskIntent,
  attributeFailure,
  totemoraProductVersion,
  type LocalConfigSet,
  type ProviderRegistry,
  type RuntimeProgress,
  type TribeRun,
  type TaskAnalysis,
  type FailureAttribution,
  type MemberPerformanceSummary,
} from "@totemora/core";
import { ConfiguredProviderRegistry } from "@totemora/providers";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { SettlementStore } from "./settlement-store";
import { JobStore } from "./job-store";
import { DevelopmentCommitService } from "./development-service";
import { ToolAssetRegistry } from "./tool-asset-registry";
import { MemberStateStore } from "./member-state-store";
import { MemberConversationService } from "./member-conversation-service";
import { MemberEvolutionService } from "./member-evolution-service";
import { IntelligenceService } from "./intelligence-service";
import { IntelligencePreferenceStore } from "./intelligence-preference-store";
import { FinanceIntelligenceService } from "./finance-intelligence-service";
import type { FinanceBriefingType } from "./finance-market-snapshot-service";
import { FinancePreferenceStore } from "./finance-preference-store";
import { ActionJournal } from "./action-journal";
import { SPECIALIST_SERVICES, SpecialistTaskRepository } from "./specialist-service";
import { MemberProfileStore } from "./member-profile-store";
import { ContentStudioService, type ContentIllustrationGenerator, type CreateContentInput } from "./content-studio-service";
import { CpaIllustrationService } from "./cpa-illustration-service";
import {
  BarkNotificationService, BarkTargetMutationError, type BarkTargetMutationInput,
} from "./bark-notification-service";
import { EvidenceObservatory } from "./evidence-observatory";
import {
  SkillCommissionConflictError, SkillCommissionService, type SkillTrial,
} from "./skill-commission-service";
import { SkillRegistryService } from "./skill-registry-service";
import {
  SkillTrialConflictError, SkillTrialInputError, SkillTrialRunnerService, type SkillTrialRunInput,
} from "./skill-trial-runner-service";
import type { RecurringServiceState } from "./recurring-service-runner";

export interface PlaygroundOptions {
  configDir: string;
  dataDir: string;
  createProviderRegistry?: (config: LocalConfigSet) => ProviderRegistry;
  operatorToken?: string;
  projectRoot?: string;
  fetchImpl?: typeof fetch;
  createIllustrationGenerator?: (config: LocalConfigSet) => ContentIllustrationGenerator | undefined;
  recurringServiceStatus?: () => RecurringServiceState[];
}

interface RunJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  message: string;
  created_at: string;
  updated_at: string;
  activities: Array<{ phase: string; message: string; at: string }>;
  mission_id?: string;
  task_analysis?: TaskAnalysis;
  run?: TribeRun;
  error?: string;
  failure?: FailureAttribution;
}

interface RunInput {
  goal?: string;
  workspace?: string;
  workplace_id?: string;
  mission_id?: string;
  acceptance?: string[];
  chief?: string;
  max_files?: number;
  max_context_bytes?: number;
  max_output_tokens?: number;
  max_members?: number;
  max_total_tokens?: number;
  mission_context?: string[];
}

interface DevelopmentTask {
  id: string;
  kind: "git_flow";
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  workplace_id: string;
  goal: string;
  mode: "commit" | "pull_request" | "merge";
  issue_mode: "auto" | "none";
  proposal_id?: string;
  result?: Awaited<ReturnType<DevelopmentCommitService["prepare"]>>;
  error?: string;
  retryable?: boolean;
}

interface DevelopmentTaskInput {
  workplace_id: string;
  goal: string;
  mode?: "commit" | "pull_request" | "merge";
  issue_mode?: "auto" | "none";
  trial_commission_id?: string;
}

interface IntelligenceTask {
  id: string;
  kind: "intelligence_brief" | "finance_brief";
  domain: "ai" | "finance";
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  message_count: number;
  idempotency_key: string;
  delivery_mode: "candidate_pool" | "direct_push";
  briefing_type?: FinanceBriefingType;
  result?: Awaited<ReturnType<IntelligenceService["run"]>> | Awaited<ReturnType<FinanceIntelligenceService["run"]>>;
  error?: string;
  retryable?: boolean;
  growth_review?: { status: "not_due" | "proposed" | "failed"; proposal_id?: string; error?: string };
}

interface IntelligenceTaskInput {
  domain?: "ai" | "finance";
  message_count?: number;
  idempotency_key?: string;
  delivery_mode?: "candidate_pool" | "direct_push";
  briefing_type?: FinanceBriefingType;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createPlaygroundApp(options: PlaygroundOptions) {
  const jobs = new Map<string, RunJob>();
  const controllers = new Map<string, AbortController>();
  const jobInputs = new Map<string, RunInput>();
  const settlement = new SettlementStore(options.dataDir);
  const jobStore = new JobStore<RunJob, RunInput>(options.dataDir);
  const developmentTasks = new Map<string, DevelopmentTask>();
  const developmentTaskStore = new JobStore<DevelopmentTask, DevelopmentTaskInput>(options.dataDir, "development-tasks");
  const intelligenceTasks = new Map<string, IntelligenceTask>();
  const intelligenceTaskStore = new JobStore<IntelligenceTask, IntelligenceTaskInput>(options.dataDir, "intelligence-tasks");
  const specialistTasks = new SpecialistTaskRepository(options.dataDir);
  const barkManagement = new BarkNotificationService(options.dataDir, options.fetchImpl ?? fetch);
  const skillRegistry = new SkillRegistryService(
    options.projectRoot ?? resolve(import.meta.dir, "../../.."), options.dataDir,
  );
  const failInterruptedSpecialistTask = (taskId: string, summary: string) => {
    const task = specialistTasks.get(taskId);
    if (!task || !["queued", "routing", "running"].includes(task.status)) return;
    specialistTasks.update(task.id, task.revision, {
      status: "failed", current_stage: "failed", error: summary, summary,
    });
  };
  const runHydration = jobStore.list().then(async (records) => {
    for (const record of records) {
      const job = record.job;
      if (["queued", "running"].includes(job.status)) {
        job.status = "failed";
        job.phase = "failed";
        job.message = "服务重启中断了未完成的 Run";
        job.error = job.message;
        job.failure = {
          category: "unknown", retryable: true, owner: "runtime",
          summary: "服务重启导致运行中断，可以安全重试",
        };
        recordActivity(job, "failed", job.message);
        await jobStore.save(job, record.input);
      }
      jobs.set(job.id, job);
      jobInputs.set(job.id, record.input);
    }
  });
  const developmentHydration = developmentTaskStore.list().then(async (records) => {
    for (const record of records) {
      const task = record.job;
      if (["queued", "running"].includes(task.status)) {
        task.status = "failed";
        task.error = "Gateway restarted while the specialist task was running; start a new preparation task";
        task.retryable = true;
        task.updated_at = new Date().toISOString();
        await developmentTaskStore.save(task, record.input);
        failInterruptedSpecialistTask(task.id, task.error);
      }
      developmentTasks.set(task.id, task);
    }
  });
  const intelligenceHydration = intelligenceTaskStore.list().then(async (records) => {
    for (const record of records) {
      const task = record.job;
      task.domain ??= task.kind === "finance_brief" ? "finance" : "ai";
      if (["queued", "running"].includes(task.status)) {
        task.status = "failed";
        task.error = "Gateway restarted while the intelligence task was running; start a new task with a new idempotency key";
        task.retryable = true;
        task.updated_at = new Date().toISOString();
        await intelligenceTaskStore.save(task, record.input);
        failInterruptedSpecialistTask(task.id, task.error);
      }
      intelligenceTasks.set(task.id, task);
    }
  });
  const hydration = Promise.all([runHydration, developmentHydration, intelligenceHydration]);
  let configPromise: Promise<LocalConfigSet> | undefined;
  let memberServicesPromise: Promise<{
    state: MemberStateStore;
    conversations: MemberConversationService;
    evolution: MemberEvolutionService;
    intelligence: IntelligenceService;
    finance: FinanceIntelligenceService;
    content: ContentStudioService;
    skills: SkillCommissionService;
    skillTrials: SkillTrialRunnerService;
  }> | undefined;
  let bindingsRegistered = false;
  const getConfig = async () => {
    configPromise ??= loadLocalConfig({ configDir: options.configDir }).then((config) => {
      validateLocalConfig(config);
      return config;
    });
    return configPromise;
  };
  const ensureServiceBindings = async () => {
    if (bindingsRegistered) return;
    const config = await getConfig();
    const chief = config.tribe.tribe.chief ?? "deepseek_reasoner";
    const gitMember = config.agents.agents.find((member) => member.skills?.includes("git-flow-safety"));
    const intelligenceMember = config.agents.agents.find((member) => member.id === "qwen_intelligence");
    const financeMember = config.agents.agents.find((member) => (member.tools ?? []).includes("finance-intelligence"));
    const contentWriter = config.agents.agents.find((member) => member.skills?.includes("tutorial-writing"));
    if (gitMember) specialistTasks.registerBinding({
      service_id: "git.flow", chief_member_id: chief, specialist_member_id: gitMember.id,
      routing_reason: "当前唯一具备 git-flow-safety 且处于 active 状态的成员",
      capability_evidence: ["git-flow-safety"], tool_grants: ["git-flow-engine", "opencode-correction"],
    });
    if (intelligenceMember) specialistTasks.registerBinding({
      service_id: "intelligence.watch", chief_member_id: chief, specialist_member_id: intelligenceMember.id,
      routing_reason: "Chief 已批准的常驻听风岗位；定时巡查复用委任，不重复调用 Chief",
      capability_evidence: ["news-intelligence"],
      tool_grants: ["news-intelligence", "aihot-public-feed", "internal-bark", "telegram-bot"],
    });
    if (financeMember) specialistTasks.registerBinding({
      service_id: "finance.watch", chief_member_id: chief, specialist_member_id: financeMember.id,
      routing_reason: "Chief 已批准的常驻观潮岗位；财经领域与听风候选、反馈和成长证据保持隔离",
      capability_evidence: (financeMember.skills ?? []).filter((skill) => ["financial-intelligence-briefing", "finance-source-verification"].includes(skill)),
      tool_grants: (financeMember.tools ?? []).filter((tool) => ["finance-intelligence", "official-finance-sources", "internal-bark", "telegram-bot"].includes(tool)),
    });
    if (contentWriter) specialistTasks.registerBinding({
      service_id: "content.studio", chief_member_id: chief, specialist_member_id: contentWriter.id,
      routing_reason: "Chief 批准的内容写作常驻委任；研究、审校与配图成员在单次任务 assignments 中独立记录",
      capability_evidence: (contentWriter.skills ?? []).filter((skill) => ["structured-writing", "tutorial-writing"].includes(skill)),
      tool_grants: (contentWriter.tools ?? []).filter((tool) => tool === "content-studio"),
    });
    bindingsRegistered = true;
  };
  const getDevelopmentService = async () => {
    const config = await getConfig();
    const registry = options.createProviderRegistry?.(config) ?? new ConfiguredProviderRegistry(config);
    return new DevelopmentCommitService(
      config, registry, settlement, options.dataDir,
      options.projectRoot ?? resolve(import.meta.dir, "../../.."),
    );
  };
  const getAssetRegistry = () => new ToolAssetRegistry(
    options.projectRoot ?? resolve(import.meta.dir, "../../.."),
    options.dataDir,
  );
  const getMemberServices = async () => {
    memberServicesPromise ??= (async () => {
      const config = await getConfig();
      const providers = options.createProviderRegistry?.(config) ?? new ConfiguredProviderRegistry(config);
      const state = new MemberStateStore(options.dataDir, config);
      const illustrationGenerator = options.createIllustrationGenerator?.(config)
        ?? (!options.createProviderRegistry && config.providers.providers.cpa
          ? new CpaIllustrationService(config, options.dataDir, options.fetchImpl ?? fetch)
          : undefined);
      const content = new ContentStudioService(
        config, providers, state, options.dataDir, illustrationGenerator, getAssetRegistry(),
      );
      for (const work of content.list(500)) {
        if (work.status === "failed" && work.error?.startsWith("Gateway restarted while content members were collaborating")) {
          failInterruptedSpecialistTask(work.id, work.error);
        }
      }
      const skills = new SkillCommissionService(config, providers, options.dataDir);
      return {
        state,
        conversations: new MemberConversationService(config, providers, state, options.dataDir),
        evolution: new MemberEvolutionService(config, providers, state),
        intelligence: new IntelligenceService(
          config, providers, state, options.dataDir,
          options.projectRoot ?? resolve(import.meta.dir, "../../.."),
          options.fetchImpl ?? fetch,
        ),
        finance: new FinanceIntelligenceService(
          config, providers, state, options.dataDir,
          options.projectRoot ?? resolve(import.meta.dir, "../../.."),
          options.fetchImpl ?? fetch,
        ),
        skills,
        skillTrials: new SkillTrialRunnerService(
          config, providers, skills, options.dataDir,
          async (workplaceId, goal, trialOptions) => (await getDevelopmentService()).prepare(workplaceId, goal, trialOptions),
        ),
        content,
      };
    })();
    return memberServicesPromise;
  };
  const enqueueDevelopmentTask = async (input: DevelopmentTaskInput): Promise<DevelopmentTask> => {
    if (!input.workplace_id || !input.goal?.trim()) throw new Error("workplace_id and goal are required");
    const now = new Date().toISOString();
    const task: DevelopmentTask = {
      id: crypto.randomUUID(), kind: "git_flow", status: "queued",
      created_at: now, updated_at: now, workplace_id: input.workplace_id, goal: input.goal.trim(),
      mode: input.mode ?? "commit", issue_mode: input.issue_mode ?? (input.mode === "commit" || !input.mode ? "none" : "auto"),
    };
    developmentTasks.set(task.id, task);
    await developmentTaskStore.save(task, input);
    await ensureServiceBindings();
    let serviceTask = specialistTasks.create({
      id: task.id, service_id: "git.flow", service_version: 1, operation: task.mode,
      trigger: "manual", status: "queued", current_stage: "routing",
      chief_member_id: (await getConfig()).tribe.tribe.chief,
      idempotency_key: task.id, input,
    });
    void (async () => {
      task.status = "running";
      task.updated_at = new Date().toISOString();
      await developmentTaskStore.save(task, input);
      serviceTask = specialistTasks.update(task.id, serviceTask.revision, {
        status: "running", current_stage: "inspect", summary: "Chief 开始路由并检查工作地",
      });
      try {
        task.result = await (await getDevelopmentService()).prepare(input.workplace_id, input.goal.trim(), {
          mode: task.mode, issue_mode: task.issue_mode, trial_commission_id: input.trial_commission_id,
        });
        task.proposal_id = task.result.id;
      } catch (error) {
        task.error = error instanceof Error ? error.message : String(error);
        task.retryable = true;
      }
      const terminalTask: DevelopmentTask = {
        ...task,
        status: task.error ? "failed" : "completed",
        updated_at: new Date().toISOString(),
      };
      await developmentTaskStore.save(terminalTask, input);
      Object.assign(task, terminalTask);
      specialistTasks.update(task.id, serviceTask.revision, task.error ? {
        status: "failed", current_stage: "failed", error: task.error,
        summary: `Git 专业任务失败：${task.error}`,
      } : {
        status: "waiting_approval", current_stage: "local_gate",
        result: task.result, result_ref: task.proposal_id,
        member_id: task.result?.specialist_member_id,
        summary: "专员已完成准备与自检，等待对应 Git 门禁",
      });
    })();
    return task;
  };
  const enqueueIntelligenceTask = async (input: IntelligenceTaskInput): Promise<IntelligenceTask> => {
    const domain = input.domain ?? "ai";
    const messageCount = Math.max(1, Math.min(5, input.message_count ?? 1));
    const deliveryMode = input.delivery_mode ?? "candidate_pool";
    await intelligenceHydration;
    if (input.idempotency_key) {
      const existing = [...intelligenceTasks.values()].find((task) =>
        task.domain === domain && task.idempotency_key === input.idempotency_key,
      );
      if (existing) {
        if (existing.message_count !== messageCount || existing.delivery_mode !== deliveryMode
          || existing.briefing_type !== input.briefing_type) {
          throw new HttpError(409, `Idempotency key ${input.idempotency_key} was reused with different intelligence task input`);
        }
        return existing;
      }
    }
    const finance = domain === "finance";
    const serviceId = finance ? "finance.watch" : "intelligence.watch";
    const memberId = finance ? "qwen_finance" : "qwen_intelligence";
    const memberName = finance ? "观潮" : "听风";
    const now = new Date().toISOString();
    const task: IntelligenceTask = {
      id: crypto.randomUUID(), kind: finance ? "finance_brief" : "intelligence_brief", domain, status: "queued",
      created_at: now, updated_at: now,
      message_count: messageCount,
      idempotency_key: input.idempotency_key ?? `${domain}-intelligence-${crypto.randomUUID()}`,
      delivery_mode: deliveryMode,
      ...(input.briefing_type ? { briefing_type: input.briefing_type } : {}),
    };
    intelligenceTasks.set(task.id, task);
    await intelligenceTaskStore.save(task, input);
    await ensureServiceBindings();
    let serviceTask = specialistTasks.create({
      id: task.id, service_id: serviceId, service_version: 1, operation: "scan",
      trigger: "manual", status: "queued", current_stage: "collect",
      member_id: memberId, chief_member_id: (await getConfig()).tribe.tribe.chief,
      idempotency_key: task.idempotency_key, input,
    });
    void (async () => {
      task.status = "running"; task.updated_at = new Date().toISOString();
      await intelligenceTaskStore.save(task, input);
      serviceTask = specialistTasks.update(task.id, serviceTask.revision, {
        status: "running", current_stage: "collect", summary: `${memberName}开始采集白名单来源`,
        member_id: memberId,
      });
      try {
        const services = await getMemberServices();
        task.result = finance ? await services.finance.run({
          message_count: task.message_count, idempotency_key: task.idempotency_key, reason: "manual",
          defer_push: task.delivery_mode === "candidate_pool", briefing_type: task.briefing_type,
        }) : await services.intelligence.run({
          message_count: task.message_count, idempotency_key: task.idempotency_key, reason: "manual",
          defer_push: task.delivery_mode === "candidate_pool",
        });
      } catch (error) {
        task.error = error instanceof Error ? error.message : String(error);
        task.retryable = true;
      }
      const terminal: IntelligenceTask = {
        ...task, status: task.error ? "failed" : "completed", updated_at: new Date().toISOString(),
      };
      await intelligenceTaskStore.save(terminal, input);
      Object.assign(task, terminal);
      specialistTasks.update(task.id, serviceTask.revision, task.error ? {
        status: "failed", current_stage: "failed", error: task.error,
        summary: `${memberName}扫描失败：${task.error}`,
      } : {
        status: "completed", current_stage: "candidate_gate", result: task.result,
        result_ref: task.result?.id, summary: "扫描完成；候选已进入价值门禁，扫描本身不产生成长信用",
      });
      if (task.result) {
        void (async () => {
          try {
            const proposal = await (await getMemberServices()).evolution.proposeIfEligible(task.result!.member_id);
            task.growth_review = proposal ? { status: "proposed", proposal_id: proposal.id } : { status: "not_due" };
          } catch (error) {
            task.growth_review = { status: "failed", error: error instanceof Error ? error.message : String(error) };
          }
          task.updated_at = new Date().toISOString();
          await intelligenceTaskStore.save(task, input);
        })();
      }
    })();
    return task;
  };
  const enqueueContentWork = async (
    input: CreateContentInput,
    trigger: "manual" | "scheduled" | "web" = "web",
  ) => {
    await ensureServiceBindings();
    const services = await getMemberServices();
    const work = await services.content.createQueued(input);
    let serviceTask = specialistTasks.create({
      id: work.id, service_id: "content.studio", service_version: 1,
      operation: work.format, trigger, status: "queued", current_stage: "routing",
      member_id: work.assignments.find((item) => item.role === "writer")?.member_id,
      chief_member_id: work.chief_member_id, idempotency_key: work.id, input,
    });
    void (async () => {
      serviceTask = specialistTasks.update(serviceTask.id, serviceTask.revision, {
        status: "running", current_stage: "research", actor_id: work.chief_member_id,
        summary: `Chief 已委任 ${work.assignments.length} 名成员协作创作`,
      });
      const result = await services.content.execute(work.id);
      specialistTasks.update(serviceTask.id, serviceTask.revision, result.status === "ready" ? {
        status: "completed", current_stage: "copy_ready", result, result_ref: result.id,
        member_id: result.assignments.find((item) => item.role === "writer")?.member_id,
        actor_id: result.review?.outcome === "accepted"
          ? result.assignments.find((item) => item.role === "researcher_reviewer")?.member_id
          : undefined,
        summary: result.illustration?.status === "ready"
          ? "研究、写作、独立审校与配图均已完成，内容进入图文可用状态"
          : `文字协作已完成；配图${result.illustration?.status === "failed" ? "未通过门禁，可人工重试" : "未启用"}`,
      } : {
        status: "failed", current_stage: "review", result, result_ref: result.id,
        error: result.error, summary: `内容协作失败：${result.error ?? "unknown error"}`,
      });
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const current = specialistTasks.get(work.id);
      if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
      try {
        specialistTasks.update(current.id, current.revision, {
          status: "failed", current_stage: "failed", error: message,
          summary: `内容后台任务异常收敛：${message.slice(0, 300)}`,
        });
      } catch (updateError) {
        console.error(`Unable to persist failed content specialist task ${work.id}: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
      }
    });
    return work;
  };
  const syncDevelopmentSpecialistTask = (proposal: {
    id: string; status: string; specialist_member_id: string; error?: string;
  }) => {
    const task = specialistTasks.findByResultRef("git.flow", proposal.id);
    if (!task) return;
    const stateByProposal: Record<string, { status: "running" | "waiting_approval" | "waiting_external" | "completed" | "failed"; stage: string }> = {
      awaiting_approval: { status: "waiting_approval", stage: "local_gate" },
      executing: { status: "running", stage: "local_gate" },
      awaiting_remote_approval: { status: "waiting_approval", stage: "remote_gate" },
      publishing: { status: "waiting_external", stage: "remote_gate" },
      awaiting_merge_approval: { status: "waiting_approval", stage: "merge_gate" },
      merging: { status: "waiting_external", stage: "merge_gate" },
      changes_requested: { status: "waiting_approval", stage: "plan" },
      completed: { status: "completed", stage: "accepted" },
      failed: { status: "failed", stage: "failed" },
    };
    const next = stateByProposal[proposal.status];
    if (!next) return;
    specialistTasks.update(task.id, task.revision, {
      status: next.status, current_stage: next.stage, result: proposal,
      result_ref: proposal.id, member_id: proposal.specialist_member_id,
      error: proposal.error, summary: `Git Flow 进入 ${proposal.status}`,
    });
  };

  const enqueueRun = async (input: RunInput): Promise<RunJob> => {
    if (!input.goal?.trim()) throw new Error("任务目标不能为空");
    const settlementData = await settlement.get();
    const existingMission = input.mission_id
      ? settlementData.missions.find((item) => item.id === input.mission_id)
      : undefined;
    if (input.mission_id && !existingMission) throw new Error("Mission 不存在");
    const workplaceId = input.workplace_id ?? existingMission?.workplace_id;
    const workplace = workplaceId
      ? settlementData.workplaces.find((item) => item.id === workplaceId)
      : undefined;
    if (workplaceId && !workplace) throw new Error("工作地不存在");
    const workspacePath = await registeredWorkspacePath(
      workplace?.path ?? input.workspace,
      settlementData.workplaces.map((item) => item.path),
    );
    const taskAnalysis = analyzeTaskIntent({
      goal: input.goal.trim(), has_workspace: Boolean(workspacePath),
      continuing: Boolean(input.mission_id),
    });
    if (!taskAnalysis.execution_enabled) {
      throw new Error(`任务已识别为 ${taskAnalysis.type}，但该执行模式尚未开放：${taskAnalysis.reason}`);
    }
    if (!workspacePath) throw new Error("请选择工作地或填写 Workspace 路径");
    const mission = existingMission
      ?? await settlement.createMission(input.goal.trim(), workplace?.id);
    input.workspace = workspacePath;
    input.mission_id = mission.id;
    input.mission_context = mission.requests.slice(-6).flatMap((request) => [
      `历史请求：${request.text}`,
      request.result_summary ? `历史结果：${request.result_summary}` : "",
      request.error ? `历史失败：${request.error}` : "",
    ]).filter(Boolean);
    const now = new Date().toISOString();
    const job: RunJob = {
      id: crypto.randomUUID(), status: "queued", phase: "queued",
      message: "正在收集只读 Workspace", created_at: now, updated_at: now,
      activities: [], mission_id: mission.id, task_analysis: taskAnalysis,
    };
    recordActivity(job, "queued", job.message);
    jobs.set(job.id, job);
    jobInputs.set(job.id, structuredClone(input));
    const controller = new AbortController();
    controllers.set(job.id, controller);
    await settlement.addRequest(mission.id, input.goal.trim(), job.id);
    await jobStore.save(job, input);
    void executeRun(job, input, options, await getConfig(), settlement, controller, jobStore);
    return job;
  };

  return {
    jobs,
    async runScheduledIntelligence() {
      await ensureServiceBindings();
      const services = await getMemberServices();
      const result = await services.intelligence.runDue();
      if (result?.scan) {
        const task = specialistTasks.create({
          id: crypto.randomUUID(), service_id: "intelligence.watch", service_version: 1,
          operation: "scan", trigger: "scheduled", status: "completed", current_stage: "candidate_gate",
          member_id: result.scan.member_id, chief_member_id: (await getConfig()).tribe.tribe.chief,
          idempotency_key: `scheduled:${result.scan.id}`, input: { reason: "scheduled" },
          result: result.scan, result_ref: result.scan.id,
        });
        void task;
        void services.evolution.proposeIfEligible(result.scan.member_id).catch(async (error) => {
          await services.state.remember({
            member_id: result.scan!.member_id, kind: "system_failure", verified: true, source_id: result.scan!.id,
            summary: `自动成长评审失败：${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
          });
        });
      }
      return result;
    },
    async runScheduledFinance() {
      await ensureServiceBindings();
      const services = await getMemberServices();
      const result = await services.finance.runDue();
      if (result?.scan) {
        const task = specialistTasks.create({
          id: crypto.randomUUID(), service_id: "finance.watch", service_version: 1,
          operation: "scan", trigger: "scheduled", status: "completed", current_stage: "candidate_gate",
          member_id: result.scan.member_id, chief_member_id: (await getConfig()).tribe.tribe.chief,
          idempotency_key: `scheduled:${result.scan.id}`, input: { reason: "scheduled", domain: "finance" },
          result: result.scan, result_ref: result.scan.id,
        });
        void task;
        void services.evolution.proposeIfEligible(result.scan.member_id).catch(async (error) => {
          await services.state.remember({
            member_id: result.scan!.member_id, kind: "system_failure", verified: true, source_id: result.scan!.id,
            summary: `财经成员自动成长评审失败：${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
          });
        });
      }
      return result;
    },
    async runScheduledContent() {
      const input = await (await getMemberServices()).content.dueInput();
      return input ? enqueueContentWork(input, "scheduled") : undefined;
    },
    async fetch(request: Request): Promise<Response> {
      await hydration;
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/api/tribe") {
          const config = await getConfig();
          return json({
            tribe: config.tribe.tribe,
            members: config.agents.agents.map((member) => ({
              id: member.id,
              name: member.name ?? member.id,
              model: member.model,
              provider: member.provider,
              status: member.status ?? "active",
              version: member.version ?? 1,
              profile: member.profile,
              roles: member.eligible_roles,
              skills: member.skills ?? [],
              persona: member.persona ?? "",
              ember_id: `${member.provider}/${member.model}`,
              lineage: member.lineage,
              lifecycle: member.lifecycle,
            })),
          });
        }

        if (request.method === "GET" && url.pathname === "/api/status") {
          const config = await getConfig();
          return json({
            version: totemoraProductVersion(),
            settlement: "ready",
            active_members: config.agents.agents.filter((member) => !["inactive", "retired"].includes(member.status ?? "active")).length,
            capabilities: {
              inspect: "enabled", continue: "enabled", answer: "gated",
              change: "git_flow_existing_changes", operate: "policy_gated", cancellation: "enabled",
              persistent_jobs: "enabled", safe_retry: "enabled",
              budget_staffing: "evidence_v1", specialist_self_review: "enabled",
              member_growth: "credited_evidence_and_effect_observation_v3",
              development_git_flow: options.operatorToken ? "enabled" : "needs_operator_token",
              mcp: "streamable_http_and_stdio",
              tribe_assets: "catalog_permissions_evidence_v1",
              member_dossiers: "portrait_experience_evolution_v2",
              member_chat: "mentor_escalation_v1",
              intelligence_watch: "ten_minute_candidate_pool_v3",
              intelligence_candidate_pool: "sqlite_feedback_retry_circuit_v2",
              finance_intelligence_watch: "official_source_domain_v1",
              finance_source_ledger: "tiered_health_cache_v1",
              durable_state: "sqlite_wal_v1",
              internal_bark: "self_hosted_multi_target_v3_api",
              telegram_bot: "group_commands_feedback_v1",
              content_studio: "three_member_text_visual_evidence_v2",
              specialist_services: "typed_contract_v1",
              evidence_observatory: "cross_domain_funnel_v1",
              conversational_skills: "commission_trial_activation_v1",
              skill_registry: "local_package_browser_v2",
              skill_trials: "member_baseline_trial_review_v1",
            },
          });
        }

        if (request.method === "GET" && url.pathname === "/api/operator/session") {
          requireOperator(request, options.operatorToken);
          return json({ authenticated: true });
        }

        if (request.method === "GET" && url.pathname === "/api/services") {
          await ensureServiceBindings();
          return json({ services: SPECIALIST_SERVICES, bindings: specialistTasks.bindings() });
        }

        if (request.method === "GET" && url.pathname === "/api/evidence/overview") {
          return json(await new EvidenceObservatory(options.dataDir, await getConfig()).overview());
        }

        if (request.method === "GET" && url.pathname === "/api/operations/recurring-services") {
          requireOperator(request, options.operatorToken);
          return json({ services: options.recurringServiceStatus?.() ?? [] });
        }

        if (request.method === "GET" && url.pathname === "/api/skills/commissions") {
          requireOperator(request, options.operatorToken);
          return json({ commissions: (await getMemberServices()).skills.list() });
        }

        if (request.method === "GET" && url.pathname === "/api/skills/trial-runs") {
          requireOperator(request, options.operatorToken);
          return json({ runs: (await getMemberServices()).skillTrials.list(url.searchParams.get("commission_id") ?? undefined) });
        }

        const skillTrialRunDetailMatch = url.pathname.match(/^\/api\/skills\/trial-runs\/([^/]+)$/);
        if (request.method === "GET" && skillTrialRunDetailMatch) {
          requireOperator(request, options.operatorToken);
          const run = (await getMemberServices()).skillTrials.get(skillTrialRunDetailMatch[1]!);
          return run ? json(run) : json({ error: "Skill trial run not found" }, 404);
        }

        if (request.method === "GET" && url.pathname === "/api/skills/registry") {
          try { return json(await skillRegistry.list({ refresh: url.searchParams.get("refresh") === "1" })); }
          catch (error) {
            console.error(JSON.stringify({ event: "skill_registry_scan_failed", error: error instanceof Error ? error.message : String(error) }));
            return json({ error: "Skill registry scan failed" }, 500);
          }
        }

        if (request.method === "POST" && url.pathname === "/api/skills/registry") {
          requireOperator(request, options.operatorToken);
          try {
            const input = await request.json() as { id?: string; name?: string; description?: string; content?: string };
            if (!input.id || typeof input.id !== "string") return json({ error: "Skill id is required" }, 400);
            const created = await skillRegistry.create({
              id: input.id,
              name: input.name,
              description: input.description,
              content: input.content,
            });
            return json(created, 201);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to create Skill";
            if (["Invalid Skill id", "Skill already exists", "Skill id is required"].includes(message)) {
              return json({ error: message }, 400);
            }
            console.error(JSON.stringify({ event: "skill_creation_failed", error: message }));
            return json({ error: message }, 500);
          }
        }

        const skillRegistryFileMatch = url.pathname.match(/^\/api\/skills\/registry\/([^/]+)\/file$/);
        if (request.method === "GET" && skillRegistryFileMatch) {
          requireOperator(request, options.operatorToken);
          try {
            return json(await skillRegistry.readFile(
              decodeURIComponent(skillRegistryFileMatch[1]!),
              url.searchParams.get("path") ?? "",
            ));
          } catch (error) {
            const message = error instanceof Error ? error.message : "Skill file preview failed";
            if (["Invalid Skill id", "Invalid Skill file path"].includes(message)) return json({ error: message }, 400);
            if (["Skill not found", "Skill file not found"].includes(message)) return json({ error: message }, 404);
            if (message === "Skill file preview forbidden") return json({ error: message }, 415);
            if (message === "Skill file preview too large") return json({ error: message }, 413);
            console.error(JSON.stringify({ event: "skill_registry_file_failed", error: message }));
            return json({ error: "Skill file preview failed" }, 500);
          }
        }

        const skillRegistryMatch = url.pathname.match(/^\/api\/skills\/registry\/([^/]+)$/);
        if (request.method === "GET" && skillRegistryMatch) {
          try {
            const skill = await skillRegistry.get(decodeURIComponent(skillRegistryMatch[1]!));
            return skill ? json(skill) : json({ error: "Skill not found" }, 404);
          } catch (error) {
            if (error instanceof Error && error.message === "Invalid Skill id") return json({ error: error.message }, 400);
            console.error(JSON.stringify({ event: "skill_registry_scan_failed", error: error instanceof Error ? error.message : String(error) }));
            return json({ error: "Skill registry scan failed" }, 500);
          }
        }

        if (request.method === "POST" && url.pathname === "/api/skills/commissions") {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { message?: string };
          return json(await (await getMemberServices()).skills.create(input.message ?? ""), 201);
        }

        const skillMessageMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/messages$/);
        if (request.method === "POST" && skillMessageMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { message?: string };
          return json(await (await getMemberServices()).skills.addMessage(skillMessageMatch[1]!, input.message ?? ""));
        }

        const skillValidateMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/validate$/);
        if (request.method === "POST" && skillValidateMatch) {
          requireOperator(request, options.operatorToken);
          return json((await getMemberServices()).skills.validate(skillValidateMatch[1]!));
        }

        const skillTrialMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/trials$/);
        if (request.method === "POST" && skillTrialMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as Pick<SkillTrial,
            "baseline_evidence_id" | "trial_evidence_id" | "reviewer_member_id" | "outcome" | "summary"
          >;
          return json((await getMemberServices()).skills.recordTrial(skillTrialMatch[1]!, input), 201);
        }

        const skillTrialRunMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/run-trial$/);
        if (request.method === "POST" && skillTrialRunMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as SkillTrialRunInput;
          try {
            return json((await getMemberServices()).skillTrials.start(skillTrialRunMatch[1]!, input), 202);
          } catch (error) {
            if (error instanceof SkillTrialInputError || error instanceof SkillTrialConflictError) throw error;
            const reference = crypto.randomUUID().slice(0, 8);
            console.error("Skill trial start failed", { reference, error });
            return json({ error: "Unable to start Skill trial", reference }, 500);
          }
        }

        const skillProposalMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/propose-activation$/);
        if (request.method === "POST" && skillProposalMatch) {
          requireOperator(request, options.operatorToken);
          return json((await getMemberServices()).skills.proposeActivation(skillProposalMatch[1]!));
        }

        const skillActivationMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/activate$/);
        if (request.method === "POST" && skillActivationMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { approved_by?: string };
          return json((await getMemberServices()).skills.activate(skillActivationMatch[1]!, input.approved_by ?? "operator"));
        }

        const skillRollbackMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/rollback$/);
        if (request.method === "POST" && skillRollbackMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { reviewed_by?: string };
          return json((await getMemberServices()).skills.rollback(skillRollbackMatch[1]!, input.reviewed_by ?? "operator"));
        }

        const skillCancelMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)\/cancel$/);
        if (request.method === "POST" && skillCancelMatch) {
          requireOperator(request, options.operatorToken);
          return json((await getMemberServices()).skills.cancel(skillCancelMatch[1]!));
        }

        const skillCommissionMatch = url.pathname.match(/^\/api\/skills\/commissions\/([^/]+)$/);
        if (request.method === "GET" && skillCommissionMatch) {
          requireOperator(request, options.operatorToken);
          const commission = (await getMemberServices()).skills.get(skillCommissionMatch[1]!);
          return commission ? json(commission) : json({ error: "Skill commission not found" }, 404);
        }

        if (request.method === "GET" && url.pathname === "/api/service-tasks") {
          requireOperator(request, options.operatorToken);
          return json({ tasks: specialistTasks.list(Number(url.searchParams.get("limit") ?? 100)) });
        }

        const specialistTaskMatch = url.pathname.match(/^\/api\/service-tasks\/([^/]+)$/);
        if (request.method === "GET" && specialistTaskMatch) {
          requireOperator(request, options.operatorToken);
          const task = specialistTasks.get(specialistTaskMatch[1]!);
          return task ? json(task) : json({ error: "Specialist task not found" }, 404);
        }

        if (request.method === "GET" && url.pathname === "/api/members/dossiers") {
          return json({ members: await (await getMemberServices()).state.listDossiers() });
        }

        const memberMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
        if (request.method === "GET" && memberMatch) {
          return json(await (await getMemberServices()).state.getDossier(memberMatch[1]!));
        }

        const memberMessagesMatch = url.pathname.match(/^\/api\/members\/([^/]+)\/messages$/);
        if (request.method === "GET" && memberMessagesMatch) {
          return json({ messages: await (await getMemberServices()).conversations.list(memberMessagesMatch[1]!) });
        }

        const evolutionProposalMatch = url.pathname.match(/^\/api\/members\/([^/]+)\/evolution\/proposals$/);
        if (request.method === "POST" && evolutionProposalMatch) {
          requireOperator(request, options.operatorToken);
          return json(await (await getMemberServices()).evolution.propose(evolutionProposalMatch[1]!), 201);
        }

        const evolutionReviewMatch = url.pathname.match(/^\/api\/members\/([^/]+)\/evolution\/proposals\/([^/]+)\/review$/);
        if (request.method === "POST" && evolutionReviewMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { approve?: boolean; reviewer_id?: string };
          if (!input.reviewer_id) throw new Error("reviewer_id is required");
          return json(await (await getMemberServices()).evolution.review(evolutionReviewMatch[1]!, evolutionReviewMatch[2]!, input.reviewer_id, Boolean(input.approve)));
        }

        const memberChatMatch = url.pathname.match(/^\/api\/members\/([^/]+)\/chat$/);
        if (request.method === "POST" && memberChatMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { message?: string; ask_mentor?: boolean };
          return json(await (await getMemberServices()).conversations.chat(
            memberChatMatch[1]!, input.message ?? "", Boolean(input.ask_mentor),
          ));
        }

        if (request.method === "GET" && url.pathname === "/api/intelligence") {
          return json({ briefs: await (await getMemberServices()).intelligence.list() });
        }

        if (request.method === "GET" && url.pathname === "/api/intelligence/candidates") {
          const intelligence = (await getMemberServices()).intelligence;
          const [candidates, counts] = await Promise.all([
            intelligence.listCandidates(), intelligence.candidateCounts(),
          ]);
          return json({
            candidates,
            counts,
          });
        }

        if (request.method === "GET" && url.pathname === "/api/finance") {
          return json({ briefs: await (await getMemberServices()).finance.list() });
        }

        if (request.method === "GET" && url.pathname === "/api/finance/candidates") {
          const finance = (await getMemberServices()).finance;
          const [candidates, counts] = await Promise.all([
            finance.listCandidates(), finance.candidateCounts(),
          ]);
          return json({ candidates, counts });
        }

        if (request.method === "GET" && url.pathname === "/api/finance/sources") {
          return json({ sources: await (await getMemberServices()).finance.sourceStatus() });
        }

        if (request.method === "GET" && url.pathname === "/api/content/works") {
          requireOperator(request, options.operatorToken);
          return json({ works: (await getMemberServices()).content.list(Number(url.searchParams.get("limit") ?? 100)) });
        }

        if (request.method === "POST" && url.pathname === "/api/content/works") {
          requireOperator(request, options.operatorToken);
          return json(await enqueueContentWork(await request.json() as CreateContentInput, "web"), 202);
        }

        if (request.method === "GET" && url.pathname === "/api/content/preferences") {
          return json((await getMemberServices()).content.preferences());
        }

        if (request.method === "PUT" && url.pathname === "/api/content/preferences") {
          requireOperator(request, options.operatorToken);
          return json((await getMemberServices()).content.savePreferences(await request.json()));
        }

        const contentCopiedMatch = url.pathname.match(/^\/api\/content\/works\/([^/]+)\/copied$/);
        if (request.method === "POST" && contentCopiedMatch) {
          requireOperator(request, options.operatorToken);
          return json(await (await getMemberServices()).content.markCopied(contentCopiedMatch[1]!));
        }

        const contentIllustrationRetryMatch = url.pathname.match(/^\/api\/content\/works\/([^/]+)\/illustration\/retry$/);
        if (request.method === "POST" && contentIllustrationRetryMatch) {
          requireOperator(request, options.operatorToken);
          const content = (await getMemberServices()).content;
          const work = content.get(contentIllustrationRetryMatch[1]!);
          if (!work) return json({ error: "Content work not found" }, 404);
          if (work.status !== "ready" || !work.body) return json({ error: "Only ready content can regenerate an illustration" }, 409);
          void content.retryIllustration(work.id).catch((error) => {
            console.error(`Illustration retry failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          return json(work, 202);
        }

        const contentIllustrationMatch = url.pathname.match(/^\/api\/content\/works\/([^/]+)\/illustration$/);
        if (request.method === "GET" && contentIllustrationMatch) {
          requireOperator(request, options.operatorToken);
          const illustration = await (await getMemberServices()).content.readIllustration(contentIllustrationMatch[1]!);
          if (!illustration) return json({ error: "Content illustration not found" }, 404);
          return new Response(Buffer.from(illustration.data), { headers: {
            "content-type": illustration.mimeType,
            "content-disposition": `inline; filename="${illustration.filename}"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          } });
        }

        const contentWorkMatch = url.pathname.match(/^\/api\/content\/works\/([^/]+)$/);
        if (request.method === "GET" && contentWorkMatch) {
          requireOperator(request, options.operatorToken);
          const work = (await getMemberServices()).content.get(contentWorkMatch[1]!);
          return work ? json(work) : json({ error: "Content work not found" }, 404);
        }

        if (request.method === "GET" && url.pathname === "/api/intelligence/bark") {
          requireOperator(request, options.operatorToken);
          return json(await (await getMemberServices()).intelligence.barkStatus(url.searchParams.get("health") === "1"));
        }

        if (request.method === "GET" && url.pathname === "/api/finance/bark") {
          requireOperator(request, options.operatorToken);
          return json(await (await getMemberServices()).finance.barkStatus(url.searchParams.get("health") === "1"));
        }

        if (request.method === "GET" && url.pathname === "/api/notifications/bark/targets") {
          requireOperator(request, options.operatorToken);
          return json(await barkManagement.managementStatus(url.searchParams.get("health") === "1"));
        }

        if (request.method === "POST" && url.pathname === "/api/notifications/bark/targets") {
          requireOperator(request, options.operatorToken);
          try {
            return json(await barkManagement.upsertManagedTarget(
              await request.json() as BarkTargetMutationInput, "create",
            ), 201);
          } catch (error) {
            if (error instanceof BarkTargetMutationError) throw new HttpError(error.status, error.message);
            throw error;
          }
        }

        if (request.method === "GET" && url.pathname === "/api/notifications/bark/audit") {
          requireOperator(request, options.operatorToken);
          return json({ events: await barkManagement.listManagementAudit() });
        }

        const barkTargetTestMatch = url.pathname.match(/^\/api\/notifications\/bark\/targets\/([^/]+)\/test$/);
        if (request.method === "POST" && barkTargetTestMatch) {
          requireOperator(request, options.operatorToken);
          const targetId = decodeURIComponent(barkTargetTestMatch[1]!);
          const input = await request.json().catch(() => ({})) as { idempotency_key?: string };
          const idempotencyKey = input.idempotency_key?.trim() || `web-bark-test:${targetId}:${crypto.randomUUID()}`;
          try {
            const result = await new ActionJournal(options.dataDir).executeEffectOnce({
              idempotency_key: idempotencyKey, asset_id: "internal-bark", member_id: "operator",
              action: "test_notification", request: { target_id: targetId },
            }, async () => {
              const receipt = await barkManagement.pushTo(targetId, {
                id: `test-${crypto.randomUUID()}`, title: "Totemora 设备测试",
                body: "这台设备已接入部落通知控制面。AI / 财经领域路由将按设备配置生效。",
              });
              return `Bark target ${targetId} accepted test with status ${receipt.status}`;
            });
            await barkManagement.recordTestAudit(targetId, true, result.record.evidence ?? "accepted");
            return json({ target_id: targetId, accepted: true, replayed: result.replayed });
          } catch (error) {
            await barkManagement.recordTestAudit(targetId, false, error instanceof Error ? error.message : String(error));
            throw error;
          }
        }

        const barkTargetMatch = url.pathname.match(/^\/api\/notifications\/bark\/targets\/([^/]+)$/);
        if (request.method === "PUT" && barkTargetMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as Omit<BarkTargetMutationInput, "id">;
          try {
            return json(await barkManagement.upsertManagedTarget(
              { ...input, id: decodeURIComponent(barkTargetMatch[1]!) }, "update",
            ));
          } catch (error) {
            if (error instanceof BarkTargetMutationError) throw new HttpError(error.status, error.message);
            throw error;
          }
        }

        if (request.method === "GET" && url.pathname === "/api/intelligence/telegram") {
          requireOperator(request, options.operatorToken);
          return json(await (await getMemberServices()).intelligence.telegramStatus(url.searchParams.get("health") === "1"));
        }

        if (request.method === "POST" && url.pathname === "/api/integrations/telegram/webhook") {
          const intelligence = (await getMemberServices()).intelligence;
          try {
            await intelligence.verifyTelegramWebhook(
              request.headers.get("x-telegram-bot-api-secret-token"),
            );
          } catch {
            throw new HttpError(401, "Telegram webhook authorization failed");
          }
          const contentLength = Number(request.headers.get("content-length") ?? 0);
          if (contentLength > 128_000) throw new HttpError(413, "Telegram update is too large");
          const rawUpdate = await request.text();
          if (Buffer.byteLength(rawUpdate) > 128_000) throw new HttpError(413, "Telegram update is too large");
          const update = JSON.parse(rawUpdate) as { update_id?: number };
          if (!Number.isSafeInteger(update.update_id)) throw new HttpError(400, "Telegram update_id is required");
          return json(await intelligence.handleTelegramUpdate(update as Parameters<typeof intelligence.handleTelegramUpdate>[0]));
        }

        const candidateFeedbackMatch = url.pathname.match(/^\/api\/intelligence\/candidates\/([^/]+)\/feedback$/);
        if (request.method === "POST" && candidateFeedbackMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { signal?: "valuable" | "not_valuable" | "duplicate" | "too_late" };
          if (!input.signal || !["valuable", "not_valuable", "duplicate", "too_late"].includes(input.signal)) {
            throw new Error("signal must be valuable, not_valuable, duplicate, or too_late");
          }
          return json(await (await getMemberServices()).intelligence.recordFeedback(candidateFeedbackMatch[1]!, input.signal));
        }

        const feedbackRedirectMatch = url.pathname.match(/^\/r\/([^/]+)$/);
        if (request.method === "GET" && feedbackRedirectMatch) {
          const result = await (await getMemberServices()).intelligence.openFeedback(decodeURIComponent(feedbackRedirectMatch[1]!));
          if (!result) return json({ error: "Feedback link not found" }, 404);
          return new Response(null, { status: 303, headers: { location: result.target_url, "cache-control": "no-store" } });
        }

        if (request.method === "GET" && url.pathname === "/api/intelligence/preferences") {
          return json({
            ...await new IntelligencePreferenceStore(options.dataDir).get(),
            credentials: {
              x_trends: await hasLocalSecret(options.dataDir, "x-bearer-token", "TOTEMORA_X_BEARER_TOKEN"),
              weibo_hot: await hasLocalSecret(options.dataDir, "weibo-access-token", "TOTEMORA_WEIBO_ACCESS_TOKEN"),
            },
          });
        }

        if (request.method === "PUT" && url.pathname === "/api/intelligence/preferences") {
          requireOperator(request, options.operatorToken);
          return json(await new IntelligencePreferenceStore(options.dataDir).save(await request.json()));
        }

        if (request.method === "GET" && url.pathname === "/api/finance/preferences") {
          return json(await new FinancePreferenceStore(options.dataDir).get());
        }

        if (request.method === "PUT" && url.pathname === "/api/finance/preferences") {
          requireOperator(request, options.operatorToken);
          return json(await new FinancePreferenceStore(options.dataDir).save(await request.json()));
        }

        if (request.method === "GET" && url.pathname === "/api/actions") {
          requireOperator(request, options.operatorToken);
          return json({ actions: (await new ActionJournal(options.dataDir).list()).slice(-100).reverse() });
        }

        if (request.method === "POST" && url.pathname === "/api/intelligence/run") {
          requireOperator(request, options.operatorToken);
          const input = await request.json().catch(() => ({})) as { message_count?: number; idempotency_key?: string };
          return json(await (await getMemberServices()).intelligence.run({
            message_count: input.message_count,
            idempotency_key: input.idempotency_key,
            reason: "manual",
          }), 201);
        }

        if (request.method === "POST" && url.pathname === "/api/finance/run") {
          requireOperator(request, options.operatorToken);
          const input = await request.json().catch(() => ({})) as {
            message_count?: number; idempotency_key?: string; briefing_type?: FinanceBriefingType;
          };
          return json(await (await getMemberServices()).finance.run({
            message_count: input.message_count,
            idempotency_key: input.idempotency_key,
            reason: "manual",
            briefing_type: input.briefing_type,
          }), 201);
        }

        if (request.method === "POST" && url.pathname === "/api/intelligence/tasks") {
          requireOperator(request, options.operatorToken);
          const input = await request.json().catch(() => ({})) as IntelligenceTaskInput;
          return json(await enqueueIntelligenceTask({ ...input, domain: "ai" }), 202);
        }

        if (request.method === "POST" && url.pathname === "/api/finance/tasks") {
          requireOperator(request, options.operatorToken);
          const input = await request.json().catch(() => ({})) as IntelligenceTaskInput;
          return json(await enqueueIntelligenceTask({ ...input, domain: "finance" }), 202);
        }

        const intelligenceTaskMatch = url.pathname.match(/^\/api\/intelligence\/tasks\/([^/]+)$/);
        if (request.method === "GET" && intelligenceTaskMatch) {
          requireOperator(request, options.operatorToken);
          const task = intelligenceTasks.get(intelligenceTaskMatch[1]!);
          return task ? json(task) : json({ error: "Intelligence task not found" }, 404);
        }

        const financeTaskMatch = url.pathname.match(/^\/api\/finance\/tasks\/([^/]+)$/);
        if (request.method === "GET" && financeTaskMatch) {
          requireOperator(request, options.operatorToken);
          const task = intelligenceTasks.get(financeTaskMatch[1]!);
          return task?.domain === "finance" ? json(task) : json({ error: "Finance task not found" }, 404);
        }

        if (request.method === "GET" && url.pathname === "/api/assets") {
          return json({ assets: await getAssetRegistry().list(await getConfig()) });
        }

        if (request.method === "GET" && url.pathname === "/api/embers") {
          const config = await getConfig();
          const embers = new Map<string, {
            id: string; provider_id: string; provider_type: string; model: string;
            status: "available" | "inactive"; member_ids: string[]; config_source: string;
          }>();
          for (const member of config.agents.agents) {
            const id = `${member.provider}/${member.model}`;
            const provider = config.providers.providers[member.provider];
            const existing = embers.get(id);
            const available = !["inactive", "retired"].includes(member.status ?? "active");
            if (existing) {
              existing.member_ids.push(member.id);
              if (available) existing.status = "available";
              continue;
            }
            embers.set(id, {
              id, provider_id: member.provider, provider_type: provider?.type ?? "unknown",
              model: member.model, status: available ? "available" : "inactive",
              member_ids: [member.id],
              config_source: provider?.settings_file ? "settings_file" : "environment",
            });
          }
          return json({ embers: [...embers.values()] });
        }

        if (request.method === "GET" && url.pathname === "/api/settlement") {
          return json(await settlement.get());
        }

        if (request.method === "POST" && url.pathname === "/api/workplaces") {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { name?: string; path?: string };
          return json(await settlement.addWorkplace(input.name ?? "", input.path ?? ""), 201);
        }

        const policyMatch = url.pathname.match(/^\/api\/workplaces\/([^/]+)\/policy$/);
        if (request.method === "PUT" && policyMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as {
            instructions?: string;
            validation_commands?: string[];
            allowed_commit_types?: string[];
            forbidden_paths?: string[];
            git_flow?: {
              remote_provider: "none" | "github";
              target_branch: string;
              allow_issue: boolean;
              allow_push: boolean;
              allow_pull_request: boolean;
              allow_merge: boolean;
              allow_opencode_fix: boolean;
            };
          };
          return json(await settlement.setWorkplacePolicy(policyMatch[1]!, {
            instructions: input.instructions ?? "",
            validation_commands: input.validation_commands ?? [],
            allowed_commit_types: input.allowed_commit_types ?? [],
            forbidden_paths: input.forbidden_paths ?? [],
            git_flow: input.git_flow,
          }));
        }

        if (request.method === "POST" && url.pathname === "/api/development/prepare") {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as {
            workplace_id?: string; goal?: string;
            mode?: "commit" | "pull_request" | "merge"; issue_mode?: "auto" | "none";
            trial_commission_id?: string;
          };
          if (!input.workplace_id || !input.goal?.trim()) throw new Error("workplace_id and goal are required");
          return json(await (await getDevelopmentService()).prepare(input.workplace_id, input.goal.trim(), {
            mode: input.mode, issue_mode: input.issue_mode, trial_commission_id: input.trial_commission_id,
          }), 201);
        }

        if (request.method === "POST" && url.pathname === "/api/development/tasks") {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as Partial<DevelopmentTaskInput>;
          return json(await enqueueDevelopmentTask({
            workplace_id: input.workplace_id ?? "",
            goal: input.goal ?? "",
            mode: input.mode,
            issue_mode: input.issue_mode,
            trial_commission_id: input.trial_commission_id,
          }), 202);
        }

        if (request.method === "GET" && url.pathname === "/api/development/tasks") {
          requireOperator(request, options.operatorToken);
          return json({ tasks: [...developmentTasks.values()]
            .sort((left, right) => right.created_at.localeCompare(left.created_at))
            .slice(0, 50) });
        }

        const developmentTaskMatch = url.pathname.match(/^\/api\/development\/tasks\/([^/]+)$/);
        if (request.method === "GET" && developmentTaskMatch) {
          requireOperator(request, options.operatorToken);
          const task = developmentTasks.get(developmentTaskMatch[1]!);
          return task ? json(task) : json({ error: "Development task not found" }, 404);
        }

        if (request.method === "GET" && url.pathname === "/api/development/proposals") {
          requireOperator(request, options.operatorToken);
          return json({ proposals: await (await getDevelopmentService()).listProposals() });
        }

        if (request.method === "GET" && url.pathname === "/api/development/skill-proposals") {
          requireOperator(request, options.operatorToken);
          return json({ proposals: await (await getDevelopmentService()).listSkillProposals() });
        }

        const skillApprovalMatch = url.pathname.match(/^\/api\/development\/skill-proposals\/([^/]+)\/approve$/);
        if (request.method === "POST" && skillApprovalMatch) {
          requireOperator(request, options.operatorToken);
          return json(await (await getDevelopmentService()).approveSkillProposal(skillApprovalMatch[1]!));
        }

        const developmentMatch = url.pathname.match(/^\/api\/development\/proposals\/([^/]+)$/);
        if (request.method === "GET" && developmentMatch) {
          requireOperator(request, options.operatorToken);
          return json(await (await getDevelopmentService()).getProposal(developmentMatch[1]!));
        }

        const approveMatch = url.pathname.match(/^\/api\/development\/proposals\/([^/]+)\/approve$/);
        if (request.method === "POST" && approveMatch) {
          requireOperator(request, options.operatorToken);
          const proposal = await (await getDevelopmentService()).approve(approveMatch[1]!);
          syncDevelopmentSpecialistTask(proposal);
          return json(proposal);
        }

        const advanceMatch = url.pathname.match(/^\/api\/development\/proposals\/([^/]+)\/advance$/);
        if (request.method === "POST" && advanceMatch) {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { gate?: "local" | "remote" | "merge" };
          const service = await getDevelopmentService();
          if (input.gate === "local") {
            const proposal = await service.approve(advanceMatch[1]!);
            syncDevelopmentSpecialistTask(proposal); return json(proposal);
          }
          if (input.gate === "remote") {
            const proposal = await service.publish(advanceMatch[1]!);
            syncDevelopmentSpecialistTask(proposal); return json(proposal);
          }
          if (input.gate === "merge") {
            const proposal = await service.merge(advanceMatch[1]!);
            syncDevelopmentSpecialistTask(proposal); return json(proposal);
          }
          throw new Error("gate must be local, remote, or merge");
        }

        if (request.method === "POST" && url.pathname === "/api/missions") {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { title?: string; workplace_id?: string };
          return json(await settlement.createMission(input.title ?? "", input.workplace_id), 201);
        }

        if (request.method === "POST" && url.pathname === "/api/intake/analyze") {
          const input = await request.json() as RunInput;
          return json(analyzeTaskIntent({
            goal: input.goal ?? "",
            has_workspace: Boolean(input.workplace_id || input.workspace?.trim()),
            continuing: Boolean(input.mission_id),
          }));
        }

        if (request.method === "POST" && url.pathname === "/api/runs") {
          requireOperator(request, options.operatorToken);
          return json(await enqueueRun((await request.json()) as RunInput), 202);
        }

        if (request.method === "GET" && url.pathname === "/api/runs") {
          return json({ runs: await listPersistedRuns(options.dataDir) });
        }

        if (request.method === "GET" && url.pathname === "/api/jobs") {
          return json({ jobs: [...jobs.values()]
            .sort((left, right) => right.created_at.localeCompare(left.created_at))
            .slice(0, 30)
            .map((job) => ({
              id: job.id, mission_id: job.mission_id, status: job.status,
              phase: job.phase, message: job.message, created_at: job.created_at,
              updated_at: job.updated_at, goal: job.run?.task.goal ?? jobInputs.get(job.id)?.goal,
              error: job.error, failure: job.failure,
            })) });
        }

        const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
        if (request.method === "POST" && cancelMatch) {
          requireOperator(request, options.operatorToken);
          const job = jobs.get(cancelMatch[1]!);
          if (!job) return json({ error: "Run job not found" }, 404);
          if (!["queued", "running"].includes(job.status)) {
            return json({ error: `Run cannot be cancelled from status ${job.status}` }, 409);
          }
          controllers.get(job.id)?.abort();
          job.message = "正在取消当前模型调用";
          recordActivity(job, "cancelling", job.message);
          await jobStore.save(job, jobInputs.get(job.id)!);
          return json(job, 202);
        }

        const retryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
        if (request.method === "POST" && retryMatch) {
          requireOperator(request, options.operatorToken);
          const previous = jobs.get(retryMatch[1]!);
          const input = jobInputs.get(retryMatch[1]!);
          if (!previous || !input) return json({ error: "Run job not found or no longer retryable" }, 404);
          if (previous.status !== "failed" || !previous.failure?.retryable) {
            return json({ error: "Only retryable failed Runs can be retried" }, 409);
          }
          return json(await enqueueRun(structuredClone(input)), 202);
        }

        const match = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
        if (request.method === "GET" && match) {
          const job = jobs.get(match[1]!);
          return job ? json(job) : json({ error: "Run job not found" }, 404);
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          error instanceof HttpError ? error.status
            : error instanceof SkillCommissionConflictError || error instanceof SkillTrialConflictError ? 409
              : error instanceof SkillTrialInputError ? 400 : 400,
        );
      }
    },
  };
}

async function executeRun(
  job: RunJob, input: RunInput, options: PlaygroundOptions, config: LocalConfigSet,
  settlement: SettlementStore,
  controller: AbortController,
  jobStore: JobStore<RunJob, RunInput>,
): Promise<void> {
  try {
    job.status = "running";
    recordActivity(job, "workspace", "正在读取受限 Workspace 快照");
    const workspace = await collectWorkspaceSnapshot(input.workspace!, {
      maxFiles: input.max_files,
      maxTotalBytes: input.max_context_bytes,
    });
    const effectiveConfig = structuredClone(config);
    const profiles = new MemberProfileStore(options.dataDir);
    for (const member of effectiveConfig.agents.agents) {
      const constitution = await profiles.current(member);
      member.persona = [
        member.persona ?? `你是部落成员 ${member.name ?? member.id}。`,
        `正式画像 v${constitution.version}：特质=${JSON.stringify(constitution.traits)}；表达=${JSON.stringify(constitution.communication_style)}；工作偏好=${JSON.stringify(constitution.working_preferences)}`,
      ].join("\n");
    }
    const registry = options.createProviderRegistry?.(effectiveConfig) ?? new ConfiguredProviderRegistry(effectiveConfig);
    const runtime = new TribeRuntime(effectiveConfig, registry, new FileRunStore(options.dataDir), undefined, {
      onProgress(progress: RuntimeProgress) {
        job.phase = progress.phase;
        job.message = progress.message;
        recordActivity(job, progress.phase, progress.message);
        void jobStore.save(job, input);
      },
    }, { signal: controller.signal });
    job.run = await runtime.runTask({
      id: `web_task_${job.id}`,
      goal: input.goal!,
      context: input.mission_context?.length
        ? ["这是同一 Mission 的后续请求。此前请求：", ...input.mission_context]
        : undefined,
      acceptance: input.acceptance?.filter(Boolean).length
        ? input.acceptance.filter(Boolean)
        : ["关键结论引用 Workspace 真实相对路径", "逐项回应用户目标"],
      workspace,
      constraints: { read_only: true },
      budget: {
        max_context_bytes: input.max_context_bytes,
        max_output_tokens_per_call: input.max_output_tokens,
        max_members: input.max_members,
        max_total_tokens: input.max_total_tokens,
      },
      member_performance: await loadMemberPerformance(options.dataDir),
    }, input.chief || undefined);
    job.phase = "completed";
    job.message = "任务已完成";
    recordActivity(job, "completed", job.message);
    await settlement.completeRequest(job.mission_id!, job.id, {
      outcome: "completed",
      result_summary: job.run.final_report?.summary ?? "任务已完成",
    });
    const completedJob: RunJob = { ...job, status: "completed" };
    await jobStore.save(completedJob, input);
    Object.assign(job, completedJob);
  } catch (error) {
    const terminalStatus = controller.signal.aborted ? "cancelled" : "failed";
    job.phase = terminalStatus;
    job.error = error instanceof Error ? error.message : String(error);
    job.failure = attributeFailure(error);
    job.message = controller.signal.aborted ? "任务已由用户取消" : job.error;
    recordActivity(job, terminalStatus, job.message);
    if (job.mission_id) {
      await settlement.completeRequest(job.mission_id, job.id, {
        outcome: "failed", error: job.message,
      });
    }
    const failedJob: RunJob = { ...job, status: terminalStatus };
    await jobStore.save(failedJob, input);
    Object.assign(job, failedJob);
  } finally {
    controller.abort();
  }
}

function recordActivity(job: RunJob, phase: string, message: string): void {
  const at = new Date().toISOString();
  job.updated_at = at;
  const previous = job.activities.at(-1);
  if (previous?.phase !== phase || previous.message !== message) {
    job.activities.push({ phase, message, at });
  }
}

async function listPersistedRuns(dataDir: string) {
  const runsDir = resolve(dataDir, "runs");
  let files: string[];
  try {
    files = (await readdir(runsDir)).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const runs = await Promise.all(files.map(async (file) => {
    try {
      const run = JSON.parse(await readFile(join(runsDir, file), "utf8")) as TribeRun;
      return {
        id: run.id, goal: run.task.goal, status: run.status,
        review_outcome: run.review_outcome, chief_member_id: run.chief_member_id,
        started_at: run.started_at, completed_at: run.completed_at,
        error: run.error, failure: run.failure, usage: run.usage,
      };
    } catch {
      return undefined;
    }
  }));
  return runs.filter((run) => run !== undefined)
    .sort((left, right) => right.started_at.localeCompare(left.started_at))
    .slice(0, 20);
}

async function loadMemberPerformance(dataDir: string): Promise<Record<string, MemberPerformanceSummary>> {
  const runsDir = resolve(dataDir, "runs");
  let files: string[];
  try { files = (await readdir(runsDir)).filter((file) => file.endsWith(".json")); }
  catch { return {}; }
  const totals: Record<string, MemberPerformanceSummary> = {};
  for (const file of files) {
    try {
      const run = JSON.parse(await readFile(join(runsDir, file), "utf8")) as TribeRun;
      const members = new Set(run.plan?.assignments.map((item) => item.member_id) ?? []);
      for (const memberId of members) {
        const item = totals[memberId] ?? { runs: 0, accepted: 0, acceptance_rate: 0, failed: 0 };
        item.runs += 1;
        if (run.review_outcome === "accepted") item.accepted += 1;
        if (run.status === "failed") item.failed += 1;
        item.acceptance_rate = item.accepted / item.runs;
        totals[memberId] = item;
      }
    } catch { /* Ignore malformed historical traces. */ }
  }
  return totals;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function requireOperator(request: Request, configuredToken?: string): void {
  if (!configuredToken) throw new HttpError(503, "Operator authorization is not configured on the server");
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBuffer = Buffer.from(configuredToken);
  const providedBuffer = Buffer.from(provided);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new HttpError(401, "Operator authorization failed");
  }
}

async function registeredWorkspacePath(input: string | undefined, registeredRoots: string[]): Promise<string | undefined> {
  if (!input?.trim()) return undefined;
  const candidate = await realpath(resolve(input.trim()));
  const roots = registeredRoots.map((rootPath) => resolve(rootPath));
  const allowed = roots.some((root) => {
    const child = relative(root, candidate);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!allowed) throw new HttpError(403, "Workspace 必须位于已登记工作地内");
  return candidate;
}

async function hasLocalSecret(dataDir: string, fileName: string, environmentName: string): Promise<boolean> {
  if (process.env[environmentName]?.trim()) return true;
  try { return Boolean((await readFile(resolve(dataDir, "secrets", fileName), "utf8")).trim()); }
  catch { return false; }
}
