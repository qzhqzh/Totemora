import type { DevelopmentCommitService, DevelopmentProposal } from "../development-service";
import { JobStore } from "../job-store";
import type { SpecialistTaskRepository } from "../specialist-service";
import { failInterruptedSpecialistTask } from "./specialist-task-recovery";

export interface DevelopmentTask {
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

export interface DevelopmentTaskInput {
  workplace_id: string;
  goal: string;
  mode?: "commit" | "pull_request" | "merge";
  issue_mode?: "auto" | "none";
  trial_commission_id?: string;
}

interface DevelopmentTaskRunnerOptions {
  dataDir: string;
  specialistTasks: SpecialistTaskRepository;
  ensureServiceBindings(): Promise<void>;
  getChiefMemberId(): Promise<string | undefined>;
  getDevelopmentService(): Promise<Pick<DevelopmentCommitService, "prepare">>;
}

const RESTART_ERROR = "Gateway restarted while the specialist task was running; start a new preparation task";

export class DevelopmentTaskRunner {
  private readonly tasks = new Map<string, DevelopmentTask>();
  private readonly store: JobStore<DevelopmentTask, DevelopmentTaskInput>;
  readonly ready: Promise<void>;

  constructor(private readonly options: DevelopmentTaskRunnerOptions) {
    this.store = new JobStore(options.dataDir, "development-tasks");
    this.ready = this.hydrate();
  }

  list(): DevelopmentTask[] {
    return [...this.tasks.values()];
  }

  get(id: string): DevelopmentTask | undefined {
    return this.tasks.get(id);
  }

  async enqueue(input: DevelopmentTaskInput): Promise<DevelopmentTask> {
    const now = new Date().toISOString();
    const task: DevelopmentTask = {
      id: crypto.randomUUID(),
      kind: "git_flow",
      status: "queued",
      created_at: now,
      updated_at: now,
      workplace_id: input.workplace_id,
      goal: input.goal.trim(),
      mode: input.mode ?? "commit",
      issue_mode: input.issue_mode ?? (input.mode === "commit" || !input.mode ? "none" : "auto"),
    };
    this.tasks.set(task.id, task);
    await this.store.save(task, input);
    await this.options.ensureServiceBindings();
    let serviceTask = this.options.specialistTasks.create({
      id: task.id,
      service_id: "git.flow",
      service_version: 1,
      operation: task.mode,
      trigger: "manual",
      status: "queued",
      current_stage: "routing",
      chief_member_id: await this.options.getChiefMemberId(),
      idempotency_key: task.id,
      input,
    });
    void this.execute(task, input, serviceTask.revision);
    return task;
  }

  syncSpecialistTask(proposal: DevelopmentProposal): void {
    const task = this.options.specialistTasks.findByResultRef("git.flow", proposal.id);
    if (!task) return;
    const stateByProposal: Record<string, {
      status: "running" | "waiting_approval" | "waiting_external" | "completed" | "failed";
      stage: string;
    }> = {
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
    this.options.specialistTasks.update(task.id, task.revision, {
      status: next.status,
      current_stage: next.stage,
      result: proposal,
      result_ref: proposal.id,
      member_id: proposal.specialist_member_id,
      error: proposal.error,
      summary: `Git Flow 进入 ${proposal.status}`,
    });
  }

  private async hydrate(): Promise<void> {
    for (const record of await this.store.list()) {
      const task = record.job;
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
    task: DevelopmentTask,
    input: DevelopmentTaskInput,
    serviceTaskRevision: number,
  ): Promise<void> {
    task.status = "running";
    task.updated_at = new Date().toISOString();
    await this.store.save(task, input);
    const running = this.options.specialistTasks.update(task.id, serviceTaskRevision, {
      status: "running",
      current_stage: "inspect",
      summary: "Chief 开始路由并检查工作地",
    });
    try {
      task.result = await (await this.options.getDevelopmentService()).prepare(
        input.workplace_id,
        input.goal.trim(),
        {
          mode: task.mode,
          issue_mode: task.issue_mode,
          trial_commission_id: input.trial_commission_id,
        },
      );
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
    await this.store.save(terminalTask, input);
    Object.assign(task, terminalTask);
    this.options.specialistTasks.update(task.id, running.revision, task.error ? {
      status: "failed",
      current_stage: "failed",
      error: task.error,
      summary: `Git 专业任务失败：${task.error}`,
    } : {
      status: "waiting_approval",
      current_stage: "local_gate",
      result: task.result,
      result_ref: task.proposal_id,
      member_id: task.result?.specialist_member_id,
      summary: "专员已完成准备与自检，等待对应 Git 门禁",
    });
  }
}
