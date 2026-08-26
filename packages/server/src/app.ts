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
import {
  ContentStudioService,
  type ContentIllustrationGenerator,
  type CreateContentInput,
} from "./content-studio-service";
import { CpaIllustrationService } from "./cpa-illustration-service";
import { BarkNotificationService } from "./bark-notification-service";
import { EvidenceObservatory } from "./evidence-observatory";
import { SkillCommissionConflictError, SkillCommissionService } from "./skill-commission-service";
import { SkillRegistryService } from "./skill-registry-service";
import {
  SkillTrialConflictError, SkillTrialInputError, SkillTrialRunnerService,
} from "./skill-trial-runner-service";
import type { RecurringServiceState } from "./recurring-service-runner";
import { AbilityTemplateStore } from "./ability-template-store";
import { handleAbilityTemplateRoutes } from "./http/ability-template-routes";
import { handleContentRoutes } from "./http/content-routes";
import { handleDevelopmentRoutes } from "./http/development-routes";
import { handleFinanceRoutes } from "./http/finance-routes";
import { handleIntelligenceRoutes } from "./http/intelligence-routes";
import { handleMemberRoutes } from "./http/member-routes";
import { handleNotificationRoutes } from "./http/notification-routes";
import { handleOperationsRoutes } from "./http/operations-routes";
import { handleRunRoutes } from "./http/run-routes";
import { handleSkillCommissionRoutes } from "./http/skill-commission-routes";
import { handleSkillRegistryRoutes } from "./http/skill-registry-routes";
import { handleWorkplaceRoutes } from "./http/workplace-routes";
import { HttpError, json } from "./http/http-boundary";
import type { RunRouteInput } from "./http/run-input-schema";

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

export function createPlaygroundApp(options: PlaygroundOptions) {
  const jobs = new Map<string, RunJob>();
  const controllers = new Map<string, AbortController>();
  const jobInputs = new Map<string, RunRouteInput>();
  const settlement = new SettlementStore(options.dataDir);
  const jobStore = new JobStore<RunJob, RunRouteInput>(options.dataDir);
  const developmentTasks = new Map<string, DevelopmentTask>();
  const developmentTaskStore = new JobStore<DevelopmentTask, DevelopmentTaskInput>(options.dataDir, "development-tasks");
  const intelligenceTasks = new Map<string, IntelligenceTask>();
  const intelligenceTaskStore = new JobStore<IntelligenceTask, IntelligenceTaskInput>(options.dataDir, "intelligence-tasks");
  const specialistTasks = new SpecialistTaskRepository(options.dataDir);
  const barkManagement = new BarkNotificationService(options.dataDir, options.fetchImpl ?? fetch);
  const actionJournal = new ActionJournal(options.dataDir);
  const abilityTemplates = new AbilityTemplateStore(options.dataDir);
  const intelligencePreferences = new IntelligencePreferenceStore(options.dataDir);
  const financePreferences = new FinancePreferenceStore(options.dataDir);
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
    if (!input.workplace_id || !input.goal?.trim()) throw new HttpError(400, "workplace_id and goal are required");
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

  const enqueueRun = async (input: RunRouteInput): Promise<RunJob> => {
    const settlementData = await settlement.get();
    const existingMission = input.mission_id
      ? settlementData.missions.find((item) => item.id === input.mission_id)
      : undefined;
    if (input.mission_id && !existingMission) throw new HttpError(404, "Mission 不存在");
    const workplaceId = input.workplace_id ?? existingMission?.workplace_id;
    const workplace = workplaceId
      ? settlementData.workplaces.find((item) => item.id === workplaceId)
      : undefined;
    if (workplaceId && !workplace) throw new HttpError(404, "工作地不存在");
    const workspacePath = await registeredWorkspacePath(
      workplace?.path ?? input.workspace,
      settlementData.workplaces.map((item) => item.path),
    );
    const taskAnalysis = analyzeTaskIntent({
      goal: input.goal.trim(), has_workspace: Boolean(workspacePath),
      continuing: Boolean(input.mission_id),
    });
    if (!taskAnalysis.execution_enabled) {
      throw new HttpError(422, `任务已识别为 ${taskAnalysis.type}，但该执行模式尚未开放：${taskAnalysis.reason}`);
    }
    if (!workspacePath) throw new HttpError(400, "请选择工作地或填写 Workspace 路径");
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

  const cancelRun = async (id: string): Promise<RunJob> => {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, "Run job not found");
    if (!["queued", "running"].includes(job.status)) {
      throw new HttpError(409, `Run cannot be cancelled from status ${job.status}`);
    }
    controllers.get(job.id)?.abort();
    job.message = "正在取消当前模型调用";
    recordActivity(job, "cancelling", job.message);
    await jobStore.save(job, jobInputs.get(job.id)!);
    return job;
  };

  const retryRun = async (id: string): Promise<RunJob> => {
    const previous = jobs.get(id);
    const input = jobInputs.get(id);
    if (!previous || !input) throw new HttpError(404, "Run job not found or no longer retryable");
    if (previous.status !== "failed" || !previous.failure?.retryable) {
      throw new HttpError(409, "Only retryable failed Runs can be retried");
    }
    return enqueueRun(structuredClone(input));
  };

  const testNotificationTarget = async (targetId: string, requestedKey?: string) => {
    const idempotencyKey = requestedKey ?? `web-bark-test:${targetId}:${crypto.randomUUID()}`;
    try {
      const result = await actionJournal.executeEffectOnce({
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
      return { accepted: true as const, replayed: result.replayed };
    } catch (error) {
      await barkManagement.recordTestAudit(targetId, false, error instanceof Error ? error.message : String(error));
      throw error;
    }
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
      const url = new URL(request.url);
      try {
        await hydration;
        const abilityTemplateResponse = await handleAbilityTemplateRoutes(request, url, {
          store: abilityTemplates,
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (abilityTemplateResponse) return abilityTemplateResponse;

        const skillRegistryResponse = await handleSkillRegistryRoutes(request, url, {
          registry: skillRegistry,
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (skillRegistryResponse) return skillRegistryResponse;

        const skillCommissionResponse = await handleSkillCommissionRoutes(request, url, {
          getServices: async () => {
            const services = await getMemberServices();
            return { skills: services.skills, skillTrials: services.skillTrials };
          },
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (skillCommissionResponse) return skillCommissionResponse;

        const memberResponse = await handleMemberRoutes(request, url, {
          getServices: async () => {
            const services = await getMemberServices();
            return {
              state: services.state,
              conversations: services.conversations,
              evolution: services.evolution,
            };
          },
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (memberResponse) return memberResponse;

        const contentResponse = await handleContentRoutes(request, url, {
          getContent: async () => (await getMemberServices()).content,
          enqueue: (input) => enqueueContentWork(input, "web"),
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (contentResponse) return contentResponse;

        const intelligenceResponse = await handleIntelligenceRoutes(request, url, {
          getIntelligence: async () => (await getMemberServices()).intelligence,
          preferences: intelligencePreferences,
          credentialStatus: async () => ({
            x_trends: await hasLocalSecret(options.dataDir, "x-bearer-token", "TOTEMORA_X_BEARER_TOKEN"),
            weibo_hot: await hasLocalSecret(options.dataDir, "weibo-access-token", "TOTEMORA_WEIBO_ACCESS_TOKEN"),
          }),
          enqueueTask: (input) => enqueueIntelligenceTask(input),
          getTask: (id) => intelligenceTasks.get(id),
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (intelligenceResponse) return intelligenceResponse;

        const financeResponse = await handleFinanceRoutes(request, url, {
          getFinance: async () => (await getMemberServices()).finance,
          preferences: financePreferences,
          enqueueTask: (input) => enqueueIntelligenceTask(input),
          getTask: (id) => intelligenceTasks.get(id),
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (financeResponse) return financeResponse;

        const developmentResponse = await handleDevelopmentRoutes(request, url, {
          getDevelopment: getDevelopmentService,
          enqueueTask: enqueueDevelopmentTask,
          listTasks: () => [...developmentTasks.values()],
          getTask: (id) => developmentTasks.get(id),
          syncSpecialistTask: syncDevelopmentSpecialistTask,
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (developmentResponse) return developmentResponse;

        const workplaceResponse = await handleWorkplaceRoutes(request, url, {
          getSettlement: () => settlement.get(),
          addWorkplace: (name, path) => settlement.addWorkplace(name, path),
          setWorkplacePolicy: (id, input) => settlement.setWorkplacePolicy(id, input),
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (workplaceResponse) return workplaceResponse;

        const runResponse = await handleRunRoutes(request, url, {
          createMission: (input) => settlement.createMission(input.title, input.workplace_id),
          analyzeTask: analyzeTaskIntent,
          enqueueRun,
          listPersistedRuns: () => listPersistedRuns(options.dataDir),
          listJobs: () => [...jobs.values()],
          getJob: (id) => jobs.get(id),
          getJobGoal: (id) => jobInputs.get(id)?.goal,
          cancelRun,
          retryRun,
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (runResponse) return runResponse;

        const notificationResponse = await handleNotificationRoutes(request, url, {
          management: barkManagement,
          testTarget: testNotificationTarget,
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (notificationResponse) return notificationResponse;

        const operationsResponse = await handleOperationsRoutes(request, url, {
          recurringServiceStatus: () => options.recurringServiceStatus?.() ?? [],
          listTasks: (limit) => specialistTasks.list(limit),
          getTask: (id) => specialistTasks.get(id),
          listActions: () => actionJournal.list(),
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (operationsResponse) return operationsResponse;

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

        if (request.method === "GET" && url.pathname === "/api/services") {
          await ensureServiceBindings();
          return json({ services: SPECIALIST_SERVICES, bindings: specialistTasks.bindings() });
        }

        if (request.method === "GET" && url.pathname === "/api/evidence/overview") {
          return json(await new EvidenceObservatory(options.dataDir, await getConfig()).overview());
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

        return json({ error: "Not found" }, 404);
      } catch (error) {
        const status = error instanceof HttpError ? error.status
          : error instanceof SkillCommissionConflictError || error instanceof SkillTrialConflictError ? 409
            : error instanceof SkillTrialInputError ? 400 : undefined;
        if (status) return json({ error: error instanceof Error ? error.message : String(error) }, status);
        const reference = crypto.randomUUID().slice(0, 8);
        console.error(JSON.stringify({
          event: "gateway_request_failed", reference, method: request.method, pathname: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }));
        return json({ error: "Internal server error", reference }, 500);
      }
    },
  };
}

async function executeRun(
  job: RunJob, input: RunRouteInput, options: PlaygroundOptions, config: LocalConfigSet,
  settlement: SettlementStore,
  controller: AbortController,
  jobStore: JobStore<RunJob, RunRouteInput>,
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
