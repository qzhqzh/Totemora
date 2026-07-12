import {
  FileRunStore,
  TribeRuntime,
  collectWorkspaceSnapshot,
  loadLocalConfig,
  validateLocalConfig,
  analyzeTaskIntent,
  attributeFailure,
  type LocalConfigSet,
  type ProviderRegistry,
  type RuntimeProgress,
  type TribeRun,
  type TaskAnalysis,
  type FailureAttribution,
  type MemberPerformanceSummary,
} from "@totemora/core";
import { ConfiguredProviderRegistry } from "@totemora/providers";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { SettlementStore } from "./settlement-store";
import { JobStore } from "./job-store";
import { DevelopmentCommitService } from "./development-service";

export interface PlaygroundOptions {
  configDir: string;
  dataDir: string;
  createProviderRegistry?: (config: LocalConfigSet) => ProviderRegistry;
  operatorToken?: string;
  projectRoot?: string;
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

export function createPlaygroundApp(options: PlaygroundOptions) {
  const jobs = new Map<string, RunJob>();
  const controllers = new Map<string, AbortController>();
  const jobInputs = new Map<string, RunInput>();
  const settlement = new SettlementStore(options.dataDir);
  const jobStore = new JobStore<RunJob, RunInput>(options.dataDir);
  const hydration = jobStore.list().then(async (records) => {
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
  const getConfig = async () => {
    configPromise ??= loadLocalConfig({ configDir: options.configDir }).then((config) => {
      validateLocalConfig(config);
      return config;
    });
    return configPromise;
  };
  const getDevelopmentService = async () => {
    const config = await getConfig();
    const registry = options.createProviderRegistry?.(config) ?? new ConfiguredProviderRegistry(config);
    return new DevelopmentCommitService(
      config, registry, settlement, options.dataDir,
      options.projectRoot ?? resolve(import.meta.dir, "../../.."),
    );
  };

  const enqueueRun = async (input: RunInput): Promise<RunJob> => {
    if (!input.goal?.trim()) throw new Error("任务目标不能为空");
    const settlementData = await settlement.get();
    const workplace = input.workplace_id
      ? settlementData.workplaces.find((item) => item.id === input.workplace_id)
      : undefined;
    const workspacePath = workplace?.path ?? input.workspace?.trim();
    const taskAnalysis = analyzeTaskIntent({
      goal: input.goal.trim(), has_workspace: Boolean(workspacePath),
      continuing: Boolean(input.mission_id),
    });
    if (!taskAnalysis.execution_enabled) {
      throw new Error(`任务已识别为 ${taskAnalysis.type}，但该执行模式尚未开放：${taskAnalysis.reason}`);
    }
    if (!workspacePath) throw new Error("请选择工作地或填写 Workspace 路径");
    const mission = input.mission_id
      ? settlementData.missions.find((item) => item.id === input.mission_id)
      : await settlement.createMission(input.goal.trim(), workplace?.id);
    if (!mission) throw new Error("Mission 不存在");
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
            })),
          });
        }

        if (request.method === "GET" && url.pathname === "/api/status") {
          const config = await getConfig();
          return json({
            version: "0.3.0-development-steward",
            settlement: "ready",
            active_members: config.agents.agents.filter((member) => !["inactive", "retired"].includes(member.status ?? "active")).length,
            capabilities: {
              inspect: "enabled", continue: "enabled", answer: "gated",
              change: "commit_existing_only", operate: "gated", cancellation: "enabled",
              persistent_jobs: "enabled", safe_retry: "enabled",
              budget_staffing: "evidence_v1", independent_review: "enabled",
              member_growth: "verified_experience_context_v1",
              development_commit: options.operatorToken ? "enabled" : "needs_operator_token",
            },
          });
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
          };
          return json(await settlement.setWorkplacePolicy(policyMatch[1]!, {
            instructions: input.instructions ?? "",
            validation_commands: input.validation_commands ?? [],
            allowed_commit_types: input.allowed_commit_types ?? [],
            forbidden_paths: input.forbidden_paths ?? [],
          }));
        }

        if (request.method === "POST" && url.pathname === "/api/development/prepare") {
          requireOperator(request, options.operatorToken);
          const input = await request.json() as { workplace_id?: string; goal?: string };
          if (!input.workplace_id || !input.goal?.trim()) throw new Error("workplace_id and goal are required");
          return json(await (await getDevelopmentService()).prepare(input.workplace_id, input.goal.trim()), 201);
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
          return json(await (await getDevelopmentService()).approve(approveMatch[1]!));
        }

        if (request.method === "POST" && url.pathname === "/api/missions") {
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
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
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
    const registry = options.createProviderRegistry?.(config) ?? new ConfiguredProviderRegistry(config);
    const runtime = new TribeRuntime(config, registry, new FileRunStore(options.dataDir), undefined, {
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
    job.status = "completed";
    await jobStore.save(job, input);
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
    job.status = terminalStatus;
    await jobStore.save(job, input);
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
  if (!configuredToken) throw new Error("Development operations require TOTEMORA_OPERATOR_TOKEN on the server");
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBuffer = Buffer.from(configuredToken);
  const providedBuffer = Buffer.from(provided);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new Error("Operator authorization failed");
  }
}
