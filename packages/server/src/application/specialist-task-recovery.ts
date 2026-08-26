import type { SpecialistTaskRepository } from "../specialist-service";

export function failInterruptedSpecialistTask(
  tasks: SpecialistTaskRepository,
  taskId: string,
  summary: string,
): void {
  const task = tasks.get(taskId);
  if (!task || !["queued", "routing", "running"].includes(task.status)) return;
  tasks.update(task.id, task.revision, {
    status: "failed",
    current_stage: "failed",
    error: summary,
    summary,
  });
}
