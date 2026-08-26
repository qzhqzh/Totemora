import type { FinanceIntelligenceService } from "../finance-intelligence-service";
import type { FinanceBriefingType } from "../finance-market-snapshot-service";
import type { IntelligenceService } from "../intelligence-service";
import { JobStore } from "../job-store";
import type { MemberEvolutionService } from "../member-evolution-service";
import type { MemberStateStore } from "../member-state-store";
import type { SpecialistTaskRepository } from "../specialist-service";
import { failInterruptedSpecialistTask } from "./specialist-task-recovery";

export type IntelligenceDomain = "ai" | "finance";

export interface IntelligenceTask {
  id: string;
  kind: "intelligence_brief" | "finance_brief";
  domain: IntelligenceDomain;
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  message_count: number;
  idempotency_key: string;
  delivery_mode: "candidate_pool" | "direct_push";
  briefing_type?: FinanceBriefingType;
  result?: Awaited<ReturnType<IntelligenceService["run"]>>
    | Awaited<ReturnType<FinanceIntelligenceService["run"]>>;
  error?: string;
  retryable?: boolean;
  growth_review?: { status: "not_due" | "proposed" | "failed"; proposal_id?: string; error?: string };
}

export interface IntelligenceTaskInput {
  domain?: IntelligenceDomain;
  message_count?: number;
  idempotency_key?: string;
  delivery_mode?: "candidate_pool" | "direct_push";
  briefing_type?: FinanceBriefingType;
}

interface IntelligenceServices {
  intelligence: Pick<IntelligenceService, "run" | "runDue">;
  finance: Pick<FinanceIntelligenceService, "run" | "runDue">;
  evolution: Pick<MemberEvolutionService, "proposeIfEligible">;
  state: Pick<MemberStateStore, "remember">;
}

interface IntelligenceTaskRunnerOptions {
  dataDir: string;
  specialistTasks: SpecialistTaskRepository;
  ensureServiceBindings(): Promise<void>;
  getChiefMemberId(): Promise<string | undefined>;
  getServices(): Promise<IntelligenceServices>;
}

export class IntelligenceTaskConflictError extends Error {}

const RESTART_ERROR = "Gateway restarted while the intelligence task was running; start a new task with a new idempotency key";

export class IntelligenceTaskRunner {
  private readonly tasks = new Map<string, IntelligenceTask>();
  private readonly store: JobStore<IntelligenceTask, IntelligenceTaskInput>;
  readonly ready: Promise<void>;

  constructor(private readonly options: IntelligenceTaskRunnerOptions) {
    this.store = new JobStore(options.dataDir, "intelligence-tasks");
    this.ready = this.hydrate();
  }

  get(id: string): IntelligenceTask | undefined {
    return this.tasks.get(id);
  }

  async enqueue(input: IntelligenceTaskInput): Promise<IntelligenceTask> {
    const domain = input.domain ?? "ai";
    const messageCount = Math.max(1, Math.min(5, input.message_count ?? 1));
    const deliveryMode = input.delivery_mode ?? "candidate_pool";
    await this.ready;
    const existing = input.idempotency_key
      ? [...this.tasks.values()].find((task) =>
        task.domain === domain && task.idempotency_key === input.idempotency_key)
      : undefined;
    if (existing) {
      if (existing.message_count !== messageCount || existing.delivery_mode !== deliveryMode
        || existing.briefing_type !== input.briefing_type) {
        throw new IntelligenceTaskConflictError(
          `Idempotency key ${input.idempotency_key} was reused with different intelligence task input`,
        );
      }
      return existing;
    }

    const finance = domain === "finance";
    const now = new Date().toISOString();
    const task: IntelligenceTask = {
      id: crypto.randomUUID(),
      kind: finance ? "finance_brief" : "intelligence_brief",
      domain,
      status: "queued",
      created_at: now,
      updated_at: now,
      message_count: messageCount,
      idempotency_key: input.idempotency_key ?? `${domain}-intelligence-${crypto.randomUUID()}`,
      delivery_mode: deliveryMode,
      ...(input.briefing_type ? { briefing_type: input.briefing_type } : {}),
    };
    this.tasks.set(task.id, task);
    await this.store.save(task, input);
    await this.options.ensureServiceBindings();
    const serviceTask = this.options.specialistTasks.create({
      id: task.id,
      service_id: finance ? "finance.watch" : "intelligence.watch",
      service_version: 1,
      operation: "scan",
      trigger: "manual",
      status: "queued",
      current_stage: "collect",
      member_id: finance ? "qwen_finance" : "qwen_intelligence",
      chief_member_id: await this.options.getChiefMemberId(),
      idempotency_key: task.idempotency_key,
      input,
    });
    void this.execute(task, input, serviceTask.revision);
    return task;
  }

  async runScheduled(domain: IntelligenceDomain) {
    await this.options.ensureServiceBindings();
    const services = await this.options.getServices();
    const result = domain === "finance"
      ? await services.finance.runDue()
      : await services.intelligence.runDue();
    if (!result?.scan) return result;
    this.options.specialistTasks.create({
      id: crypto.randomUUID(),
      service_id: domain === "finance" ? "finance.watch" : "intelligence.watch",
      service_version: 1,
      operation: "scan",
      trigger: "scheduled",
      status: "completed",
      current_stage: "candidate_gate",
      member_id: result.scan.member_id,
      chief_member_id: await this.options.getChiefMemberId(),
      idempotency_key: `scheduled:${result.scan.id}`,
      input: domain === "finance" ? { reason: "scheduled", domain } : { reason: "scheduled" },
      result: result.scan,
      result_ref: result.scan.id,
    });
    void services.evolution.proposeIfEligible(result.scan.member_id).catch(async (error) => {
      await services.state.remember({
        member_id: result.scan!.member_id,
        kind: "system_failure",
        verified: true,
        source_id: result.scan!.id,
        summary: `${domain === "finance" ? "财经成员" : ""}自动成长评审失败：${errorMessage(error).slice(0, 300)}`,
      });
    });
    return result;
  }

  private async hydrate(): Promise<void> {
    for (const record of await this.store.list()) {
      const task = record.job;
      task.domain ??= task.kind === "finance_brief" ? "finance" : "ai";
      if (["queued", "running"].includes(task.status)) {
        task.status = "failed";
        task.error = RESTART_ERROR;
        task.retryable = true;
        task.updated_at = new Date().toISOString();
        await this.store.save(task, record.input);
        failInterruptedSpecialistTask(this.options.specialistTasks, task.id, task.error);
      }
      this.tasks.set(task.id, task);
    }
  }

  private async execute(
    task: IntelligenceTask,
    input: IntelligenceTaskInput,
    serviceTaskRevision: number,
  ): Promise<void> {
    const finance = task.domain === "finance";
    const memberId = finance ? "qwen_finance" : "qwen_intelligence";
    const memberName = finance ? "观潮" : "听风";
    task.status = "running";
    task.updated_at = new Date().toISOString();
    await this.store.save(task, input);
    const running = this.options.specialistTasks.update(task.id, serviceTaskRevision, {
      status: "running",
      current_stage: "collect",
      summary: `${memberName}开始采集白名单来源`,
      member_id: memberId,
    });
    try {
      const services = await this.options.getServices();
      task.result = finance ? await services.finance.run({
        message_count: task.message_count,
        idempotency_key: task.idempotency_key,
        reason: "manual",
        defer_push: task.delivery_mode === "candidate_pool",
        briefing_type: task.briefing_type,
      }) : await services.intelligence.run({
        message_count: task.message_count,
        idempotency_key: task.idempotency_key,
        reason: "manual",
        defer_push: task.delivery_mode === "candidate_pool",
      });
    } catch (error) {
      task.error = errorMessage(error);
      task.retryable = true;
    }
    const terminal: IntelligenceTask = {
      ...task,
      status: task.error ? "failed" : "completed",
      updated_at: new Date().toISOString(),
    };
    await this.store.save(terminal, input);
    Object.assign(task, terminal);
    this.options.specialistTasks.update(task.id, running.revision, task.error ? {
      status: "failed",
      current_stage: "failed",
      error: task.error,
      summary: `${memberName}扫描失败：${task.error}`,
    } : {
      status: "completed",
      current_stage: "candidate_gate",
      result: task.result,
      result_ref: task.result?.id,
      summary: "扫描完成；候选已进入价值门禁，扫描本身不产生成长信用",
    });
    if (task.result) void this.reviewGrowth(task, input);
  }

  private async reviewGrowth(task: IntelligenceTask, input: IntelligenceTaskInput): Promise<void> {
    try {
      const proposal = await (await this.options.getServices()).evolution.proposeIfEligible(task.result!.member_id);
      task.growth_review = proposal ? { status: "proposed", proposal_id: proposal.id } : { status: "not_due" };
    } catch (error) {
      task.growth_review = { status: "failed", error: errorMessage(error) };
    }
    task.updated_at = new Date().toISOString();
    await this.store.save(task, input);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
