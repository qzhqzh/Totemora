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
import { FinancePreferenceStore } from "./finance-preference-store";
import { ActionJournal } from "./action-journal";
import { SPECIALIST_SERVICES, SpecialistTaskRepository } from "./specialist-service";
import { MemberProfileStore } from "./member-profile-store";
import {
  ContentStudioService,
  type ContentIllustrationGenerator,
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
import { ContentTaskRunner } from "./application/content-task-runner";
import { DevelopmentTaskRunner } from "./application/development-task-runner";
import {
  IntelligenceTaskConflictError,
  IntelligenceTaskRunner,
} from "./application/intelligence-task-runner";

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

export function createPlaygroundApp(options: PlaygroundOptions) {
  const jobs = new Map<string, RunJob>();
  const controllers = new Map<string, AbortController>();
  const jobInputs = new Map<string, RunRouteInput>();
  const settlement = new SettlementStore(options.dataDir);
  const jobStore = new JobStore<RunJob, RunRouteInput>(options.dataDir);
  const specialistTasks = new SpecialistTaskRepository(options.dataDir);
  const barkManagement = new BarkNotificationService(options.dataDir, options.fetchImpl ?? fetch);
  const actionJournal = new ActionJournal(options.dataDir);
  const abilityTemplates = new AbilityTemplateStore(options.dataDir);
  const intelligencePreferences = new IntelligencePreferenceStore(options.dataDir);
  const financePreferences = new FinancePreferenceStore(options.dataDir);
  const skillRegistry = new SkillRegistryService(
    options.projectRoot ?? resolve(import.meta.dir, "../../.."), options.dataDir,
  );
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
  let contentTaskRunner: ContentTaskRunner;
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
      contentTaskRunner.reconcileInterrupted(content.list(500));
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
  const getChiefMemberId = async () => (await getConfig()).tribe.tribe.chief;
  const developmentTaskRunner = new DevelopmentTaskRunner({
    dataDir: options.dataDir,
    specialistTasks,
    ensureServiceBindings,
    getChiefMemberId,
    getDevelopmentService,
  });
  const intelligenceTaskRunner = new IntelligenceTaskRunner({
    dataDir: options.dataDir,
    specialistTasks,
    ensureServiceBindings,
    getChiefMemberId,
    getServices: getMemberServices,
  });
  contentTaskRunner = new ContentTaskRunner({
    specialistTasks,
    ensureServiceBindings,
    getContentService: async () => (await getMemberServices()).content,
  });
  const hydration = Promise.all([
    runHydration,
    developmentTaskRunner.ready,
    intelligenceTaskRunner.ready,
  ]);

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
    runScheduledIntelligence: () => intelligenceTaskRunner.runScheduled("ai"),
    runScheduledFinance: () => intelligenceTaskRunner.runScheduled("finance"),
    runScheduledContent: () => contentTaskRunner.runScheduled(),
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
          enqueue: (input) => contentTaskRunner.enqueue(input, "web"),
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
          enqueueTask: (input) => intelligenceTaskRunner.enqueue(input),
          getTask: (id) => intelligenceTaskRunner.get(id),
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (intelligenceResponse) return intelligenceResponse;

        const financeResponse = await handleFinanceRoutes(request, url, {
          getFinance: async () => (await getMemberServices()).finance,
          preferences: financePreferences,
          enqueueTask: (input) => intelligenceTaskRunner.enqueue(input),
          getTask: (id) => intelligenceTaskRunner.get(id),
          requireOperator: (candidate) => requireOperator(candidate, options.operatorToken),
        });
        if (financeResponse) return financeResponse;

        const developmentResponse = await handleDevelopmentRoutes(request, url, {
          getDevelopment: getDevelopmentService,
          enqueueTask: (input) => developmentTaskRunner.enqueue(input),
          listTasks: () => developmentTaskRunner.list(),
          getTask: (id) => developmentTaskRunner.get(id),
          syncSpecialistTask: (proposal) => developmentTaskRunner.syncSpecialistTask(proposal),
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
          : error instanceof IntelligenceTaskConflictError ? 409
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
