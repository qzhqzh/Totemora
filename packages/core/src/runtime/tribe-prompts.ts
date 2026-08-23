import type { AgentConfig } from "../config";
import type { StaffingPlan, TaskReport, TribeTask, WorkAssignment, WorkResult } from "./types";

export function buildChiefPlanningPrompt(
  task: TribeTask,
  chief: AgentConfig,
  members: AgentConfig[],
): string {
  const roster = members
    .filter(
      (member) =>
        member.id !== chief.id &&
        member.status !== "inactive" &&
        member.status !== "retired",
    )
    .map((member) => ({
      id: member.id,
      name: member.name ?? member.id,
      model: member.model,
      profile: member.profile,
      eligible_roles: member.eligible_roles,
      skills: member.skills ?? [],
    }));
  return [
    "你是 Totemora 部落首领。请分析任务并把工作交给最合适的成员。",
    `任务：${task.goal}`,
    `验收标准：${JSON.stringify(task.acceptance)}`,
    `入门知识：${JSON.stringify(task.context ?? [])}`,
    `可用成员：${JSON.stringify(roster)}`,
    "至少委派两个非首领成员。每个工作包必须边界清晰，并选择必要的 skills。",
    "每个工作包必须给出 assignment_reason，并用 selection_factors 列出能力、可靠性、成本或速度等实际选人因素。",
    "只输出 JSON：{summary, assignments:[{id,member_id,role,instruction,acceptance:string[],skills:string[],assignment_reason,selection_factors:string[]}]}。",
  ].join("\n");
}

export function buildGenericPlanningPrompt(
  task: TribeTask,
  chief: AgentConfig,
  members: AgentConfig[],
): string {
  const roster = members
    .filter(
      (member) =>
        member.id !== chief.id &&
        member.status !== "inactive" &&
        member.status !== "retired",
    )
    .map((member) => ({
      id: member.id,
      name: member.name ?? member.id,
      model: member.model,
      profile: member.profile,
      eligible_roles: member.eligible_roles,
      skills: member.skills ?? [],
    }));
  return [
    "你是 Totemora 部落首领。请为真实用户任务选择最小但足够的成员团队。",
    `目标：${task.goal}`,
    `验收标准：${JSON.stringify(task.acceptance)}`,
    `约束：${JSON.stringify(task.constraints ?? {})}`,
    `硬预算：${JSON.stringify(task.budget ?? {})}`,
    `Workspace 清单：${JSON.stringify(task.workspace?.files.map((file) => file.path) ?? [])}`,
    `可用成员：${JSON.stringify(roster)}`,
    "至少委派一个非首领成员。不同工作包应尽量独立，禁止安排写文件或执行命令，因为当前 Runtime 是只读模式。",
    "每个工作包必须要求成员引用 Workspace 中的真实相对路径作为证据，不得猜测未提供的文件内容。",
    "保持紧凑：summary 不超过 100 字，每个 instruction 不超过 500 字，每项 acceptance 不超过 100 字。",
    "每个工作包必须给出 assignment_reason，并用 selection_factors 列出能力、可靠性、成本或速度等实际选人因素。",
    "只输出 JSON：{summary, assignments:[{id,member_id,role,instruction,acceptance:string[],skills:string[],assignment_reason,selection_factors:string[]}]}。",
  ].join("\n");
}

export function buildPlanRepairPrompt(
  task: TribeTask,
  chief: AgentConfig,
  members: AgentConfig[],
  invalidContent: string,
  validationError: string,
  minimumAssignments: number,
): string {
  const availableMemberIds = members
    .filter(
      (member) =>
        member.id !== chief.id &&
        member.status !== "inactive" &&
        member.status !== "retired",
    )
    .map((member) => member.id);
  return [
    "你是派工计划 JSON 修复器。只修复结构、长度或成员选择错误，不改变用户目标。",
    `用户目标：${task.goal}`,
    `校验错误：${validationError}`,
    `可用非首领成员：${JSON.stringify(availableMemberIds)}`,
    `至少工作包数：${minimumAssignments}`,
    `待修复内容：${invalidContent}`,
    "输出紧凑 JSON：summary 不超过 100 字，每个 instruction 不超过 400 字，每项 acceptance 不超过 80 字。不要 Markdown。",
    "只输出 JSON：{summary, assignments:[{id,member_id,role,instruction,acceptance:string[],skills:string[],assignment_reason,selection_factors:string[]}]}。",
  ].join("\n");
}

export function buildMemberWorkPrompt(
  task: TribeTask,
  assignment: WorkAssignment,
  member: AgentConfig,
): string {
  return [
    `部落任务：${task.goal}`,
    `任务背景：${JSON.stringify(task.context ?? [])}`,
    `只读 Workspace：${formatWorkspaceForPrompt(task)}`,
    `你的工作包：${assignment.instruction}`,
    `本次角色：${assignment.role}`,
    `挂载 Skills：${assignment.skills.join(", ") || "无"}`,
    `验收标准：${assignment.acceptance.join("；")}`,
    `你的成员 ID：${member.id}`,
    "请提交一份可供首领直接验收和汇编的简洁工作成果。事实结论必须引用真实相对路径；没有证据时明确说不确定。",
  ].join("\n");
}

export function buildGenericReviewPrompt(
  task: TribeTask,
  plan: StaffingPlan,
  results: WorkResult[],
): string {
  return [
    "你是 Totemora 部落首领和最终验收人。请基于 Workspace 与成员成果生成证据化最终报告。",
    `用户目标：${task.goal}`,
    `验收标准（必须原文逐项核对）：${JSON.stringify(task.acceptance)}`,
    `约束：${JSON.stringify(task.constraints ?? {})}`,
    `Workspace：${formatWorkspaceForPrompt(task)}`,
    `派工计划：${JSON.stringify(plan)}`,
    `成员成果：${JSON.stringify(results)}`,
    "每个 finding 的 evidence 至少引用一个 Workspace 真实相对路径。区分文件事实与推断，不得声称执行了命令或修改了文件。",
    "acceptance_review 必须使用输入验收标准的原文，并逐项给出 passed/partial/failed 和证据。",
    "报告必须紧凑：summary 不超过 200 字，findings 最多 8 项，每项 evidence 最多 3 条，recommendations 最多 6 项；避免重复引用和长篇复述源码。",
    "只输出 JSON：{title,summary,findings:[{claim,evidence:string[]}],recommendations:[{priority:'high'|'medium'|'low',action,reason}],acceptance_review:[{criterion,status:'passed'|'partial'|'failed',evidence}]}。",
  ].join("\n");
}

export function buildIndependentReviewPrompt(task: TribeTask, report: TaskReport): string {
  return [
    "你是独立 Reviewer，不参与首领派工或报告编写。请只检查报告是否满足用户验收标准以及证据是否来自 Workspace。",
    `用户目标：${task.goal}`,
    `验收标准：${JSON.stringify(task.acceptance)}`,
    `允许的文件路径：${JSON.stringify(task.workspace?.files.map((file) => file.path) ?? [])}`,
    `首领报告：${JSON.stringify(report)}`,
    "只有全部标准可靠通过才 accepted；轻微缺口为 partial；事实、证据或关键标准失败为 rejected。",
    "只输出 JSON：{outcome:'accepted'|'partial'|'rejected',rationale,issues:string[]}。",
  ].join("\n");
}

export function buildReportRepairPrompt(
  task: TribeTask,
  invalidContent: string,
  validationError: string,
): string {
  return [
    "你是最终报告修复器。上一份报告未通过结构校验，请仅修复 JSON 结构和证据格式，不增加 Workspace 中不存在的事实。",
    `校验错误：${validationError}`,
    `允许引用的真实路径：${JSON.stringify(task.workspace?.files.map((file) => file.path) ?? [])}`,
    `验收标准原文：${JSON.stringify(task.acceptance)}`,
    `待修复报告：${invalidContent}`,
    "每个 finding 至少有一条 evidence 包含真实相对路径；acceptance_review 必须逐字使用验收标准原文。",
    "只输出修复后的 JSON：{title,summary,findings:[{claim,evidence:string[]}],recommendations:[{priority:'high'|'medium'|'low',action,reason}],acceptance_review:[{criterion,status:'passed'|'partial'|'failed',evidence}]}。",
  ].join("\n");
}

export function buildChiefReviewPrompt(
  task: TribeTask,
  plan: StaffingPlan,
  results: WorkResult[],
): string {
  return [
    "你是部落首领和最终验收人。请审阅成员成果，修正错误并汇编最终试卷。",
    `原任务：${task.goal}`,
    `验收标准：${JSON.stringify(task.acceptance)}`,
    `可依据的入门知识：${JSON.stringify(task.context ?? [])}`,
    `派工计划：${JSON.stringify(plan)}`,
    `成员成果：${JSON.stringify(results)}`,
    "最终必须恰好三题，覆盖不同基础能力。author_member_id 应保留主要贡献成员。",
    "只输出 JSON：{title,instructions,questions:[{id:number,prompt,answer,rationale,author_member_id}]}。",
  ].join("\n");
}

function formatWorkspaceForPrompt(task: TribeTask): string {
  if (!task.workspace) return "[]";
  return JSON.stringify({
    root_label: task.workspace.root,
    omitted_files: task.workspace.omitted_files,
    total_bytes: task.workspace.total_bytes,
    files: task.workspace.files,
  });
}
