import type {
  ContentStudioService,
  ContentWork,
  CreateContentInput,
} from "../content-studio-service";
import type { SpecialistTaskRepository } from "../specialist-service";
import { failInterruptedSpecialistTask } from "./specialist-task-recovery";

export type ContentTaskTrigger = "manual" | "scheduled" | "web";

interface ContentTaskRunnerOptions {
  specialistTasks: SpecialistTaskRepository;
  ensureServiceBindings(): Promise<void>;
  getContentService(): Promise<Pick<ContentStudioService, "createQueued" | "execute" | "dueInput">>;
}

const RESTART_ERROR_PREFIX = "Gateway restarted while content members were collaborating";

export class ContentTaskRunner {
  constructor(private readonly options: ContentTaskRunnerOptions) {}

  reconcileInterrupted(works: ContentWork[]): void {
    for (const work of works) {
      if (work.status === "failed" && work.error?.startsWith(RESTART_ERROR_PREFIX)) {
        failInterruptedSpecialistTask(this.options.specialistTasks, work.id, work.error);
      }
    }
  }

  async enqueue(input: CreateContentInput, trigger: ContentTaskTrigger = "web") {
    await this.options.ensureServiceBindings();
    const content = await this.options.getContentService();
    const work = await content.createQueued(input);
    const serviceTask = this.options.specialistTasks.create({
      id: work.id,
      service_id: "content.studio",
      service_version: 1,
      operation: work.format,
      trigger,
      status: "queued",
      current_stage: "routing",
      member_id: work.assignments.find((item) => item.role === "writer")?.member_id,
      chief_member_id: work.chief_member_id,
      idempotency_key: work.id,
      input,
    });
    void this.execute(work, content, serviceTask.revision);
    return work;
  }

  async runScheduled() {
    const input = await (await this.options.getContentService()).dueInput();
    return input ? this.enqueue(input, "scheduled") : undefined;
  }

  private async execute(
    work: ContentWork,
    content: Pick<ContentStudioService, "execute">,
    serviceTaskRevision: number,
  ): Promise<void> {
    try {
      const running = this.options.specialistTasks.update(work.id, serviceTaskRevision, {
        status: "running",
        current_stage: "research",
        actor_id: work.chief_member_id,
        summary: `Chief 已委任 ${work.assignments.length} 名成员协作创作`,
      });
      const result = await content.execute(work.id);
      this.options.specialistTasks.update(work.id, running.revision, result.status === "ready" ? {
        status: "completed",
        current_stage: "copy_ready",
        result,
        result_ref: result.id,
        member_id: result.assignments.find((item) => item.role === "writer")?.member_id,
        actor_id: result.review?.outcome === "accepted"
          ? result.assignments.find((item) => item.role === "researcher_reviewer")?.member_id
          : undefined,
        summary: result.illustration?.status === "ready"
          ? "研究、写作、独立审校与配图均已完成，内容进入图文可用状态"
          : `文字协作已完成；配图${result.illustration?.status === "failed" ? "未通过门禁，可人工重试" : "未启用"}`,
      } : {
        status: "failed",
        current_stage: "review",
        result,
        result_ref: result.id,
        error: result.error,
        summary: `内容协作失败：${result.error ?? "unknown error"}`,
      });
    } catch (error) {
      this.persistUnhandledFailure(work.id, error);
    }
  }

  private persistUnhandledFailure(workId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.options.specialistTasks.get(workId);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
    try {
      this.options.specialistTasks.update(current.id, current.revision, {
        status: "failed",
        current_stage: "failed",
        error: message,
        summary: `内容后台任务异常收敛：${message.slice(0, 300)}`,
      });
    } catch (updateError) {
      console.error(
        `Unable to persist failed content specialist task ${workId}: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
      );
    }
  }
}
