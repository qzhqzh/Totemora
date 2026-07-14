import type { AgentConfig, LocalConfigSet } from "../config";
import type { ModelResponse, ProviderRegistry } from "../provider";
import type {
  ExamPaper,
  RunEvent,
  RunStore,
  StaffingPlan,
  TaskReport,
  IndependentReview,
  TribeRun,
  TribeTask,
  WorkAssignment,
  WorkResult,
} from "./types";
import { analyzeTribeTask } from "./task-analyzer";
import { attributeFailure } from "./failure-attribution";

export interface RuntimeClock {
  now(): Date;
  id(): string;
}

export type RuntimeProgressPhase =
  | "planning"
  | "executing"
  | "reviewing"
  | "repairing"
  | "completed";

export interface RuntimeProgress {
  phase: RuntimeProgressPhase;
  message: string;
}

export interface RuntimeObserver {
  onProgress?(progress: RuntimeProgress): void;
}

export interface RuntimeControl {
  signal?: AbortSignal;
}

const DEFAULT_CLOCK: RuntimeClock = {
  now: () => new Date(),
  id: () => crypto.randomUUID(),
};

const ONBOARDING_TASK: TribeTask = {
  id: "onboarding_exam_v1",
  goal: "共同设计一份用于新成员入门考核的试卷，包含恰好三道基础题。",
  context: [
    "Totemora 是预算约束下的异构智能组织系统。少量高智能模型负责分析、派工和验收，其他成员承担边界清晰且适合自己的工作包。",
    "一个成员由基础模型、人格、Skills、工具权限、能力画像、经验、历史表现和信任等级共同构成；同一基础模型可以形成多个不同成员。",
    "部落资产由资产卡、采用图纸和部落经验构成。官方资料可以进入图纸；只有带可追踪 Run 证据的亲自验证结果才能成为部落经验。",
    "成员执行工作包时必须遵守明确范围和验收标准；失败应区分成员能力、派工、Skill、上下文和环境原因，不能简单归咎于执行成员。",
  ],
  acceptance: [
    "恰好包含三道题",
    "每道题包含题目、参考答案、考察理由和原作者成员 ID",
    "题目覆盖不同的基础能力，表述清晰且可以验收",
    "题目和答案只能依据提供的入门知识，不得虚构部落历史、图腾或制度",
  ],
};

export class TribeRuntime {
  private readonly members: Map<string, AgentConfig>;
  private tokenBudgetLimit?: number;
  private tokensUsed = 0;
  private tokensReserved = 0;

  constructor(
    private readonly config: LocalConfigSet,
    private readonly providers: ProviderRegistry,
    private readonly store: RunStore,
    private readonly clock: RuntimeClock = DEFAULT_CLOCK,
    private readonly observer: RuntimeObserver = {},
    private readonly control: RuntimeControl = {},
  ) {
    this.members = new Map(
      config.agents.agents.map((member) => [member.id, member]),
    );
  }

  async runOnboardingExam(chiefMemberId?: string): Promise<TribeRun> {
    const chief = this.resolveChief(chiefMemberId);
    const run = this.createRun(ONBOARDING_TASK, chief.id);
    await this.store.save(run);

    try {
      this.progress("planning", `${chief.id} is creating the staffing plan`);
      const planResponse = await this.callMember(
        chief,
        buildChiefPlanningPrompt(ONBOARDING_TASK, chief, [...this.members.values()]),
        "json",
      );
      this.addEvent(
        run,
        "model_response_received",
        { phase: "planning", content: planResponse.content, usage: planResponse.usage },
        chief.id,
      );
      await this.store.save(run);
      const plan = await this.parseOrRepairStaffingPlan(
        ONBOARDING_TASK,
        chief,
        planResponse.content,
        run,
        2,
      );
      run.plan = plan;
      this.addEvent(run, "plan_created", plan, chief.id);
      await this.store.save(run);

      this.progress(
        "executing",
        `${plan.assignments.length} assignment(s) dispatched to ${[...new Set(plan.assignments.map((item) => item.member_id))].join(", ")}`,
      );
      const results = await Promise.all(
        plan.assignments.map((assignment) =>
          this.executeAssignment(ONBOARDING_TASK, assignment),
        ),
      );
      run.work_results = results;
      for (const result of results) {
        this.addEvent(run, "assignment_completed", result, result.member_id);
      }
      await this.store.save(run);

      this.progress("reviewing", `${chief.id} is reviewing member results`);
      const reviewResponse = await this.callMember(
        chief,
        buildChiefReviewPrompt(ONBOARDING_TASK, plan, results),
        "json",
      );
      this.addEvent(
        run,
        "model_response_received",
        { phase: "final_review", content: reviewResponse.content, usage: reviewResponse.usage },
        chief.id,
      );
      await this.store.save(run);
      const exam = parseExamPaper(reviewResponse.content);
      validateExamPaper(exam);
      run.final_artifact = exam;
      run.review_outcome = "accepted";
      this.addEvent(run, "final_review_completed", exam, chief.id);
      run.status = "completed";
      run.usage = aggregateRunUsage(run);
      run.completed_at = this.clock.now().toISOString();
      this.addEvent(run, "run_completed", { artifact: "onboarding_exam" });
      await this.store.save(run);
      this.progress("completed", `run ${run.id} completed`);
      return run;
    } catch (error) {
      if (this.control.signal?.aborted) {
        run.status = "cancelled";
        run.completed_at = this.clock.now().toISOString();
        run.error = "Run cancelled by user";
        run.failure = attributeFailure(run.error);
        this.addEvent(run, "run_cancelled", { reason: run.error });
        await this.store.save(run);
        throw new Error(run.error);
      }
      run.status = "failed";
      run.completed_at = this.clock.now().toISOString();
      run.error = error instanceof Error ? error.message : String(error);
      run.failure = attributeFailure(error);
      this.addEvent(run, "run_failed", { error: run.error });
      await this.store.save(run);
      throw error;
    }
  }

  async runTask(task: TribeTask, chiefMemberId?: string): Promise<TribeRun> {
    validateGenericTask(task);
    const taskAnalysis = analyzeTribeTask(task);
    if (!taskAnalysis.execution_enabled) {
      throw new Error(`Task mode ${taskAnalysis.type} is not enabled: ${taskAnalysis.reason}`);
    }
    this.tokenBudgetLimit = task.budget?.max_total_tokens;
    this.tokensUsed = 0;
    this.tokensReserved = 0;
    const chief = this.resolveChief(chiefMemberId);
    const run = this.createRun(task, chief.id);
    await this.store.save(run);

    try {
      this.progress("planning", `${chief.id} is creating the staffing plan`);
      const planResponse = await this.callMember(
        chief,
        buildGenericPlanningPrompt(task, chief, [...this.members.values()]),
        "json",
        task.budget?.max_output_tokens_per_call ?? 6000,
      );
      this.addEvent(
        run,
        "model_response_received",
        { phase: "planning", content: planResponse.content, usage: planResponse.usage },
        chief.id,
      );
      await this.store.save(run);
      const plan = await this.parseOrRepairStaffingPlan(
        task,
        chief,
        planResponse.content,
        run,
        1,
      );
      run.plan = plan;
      this.addEvent(run, "plan_created", plan, chief.id);
      await this.store.save(run);

      this.progress(
        "executing",
        `${plan.assignments.length} assignment(s) dispatched to ${[...new Set(plan.assignments.map((item) => item.member_id))].join(", ")}`,
      );
      const results = await Promise.all(
        plan.assignments.map((assignment) =>
          this.executeAssignment(task, assignment),
        ),
      );
      run.work_results = results;
      for (const result of results) {
        this.addEvent(run, "assignment_completed", result, result.member_id);
      }
      await this.store.save(run);

      this.progress("reviewing", `${chief.id} is reviewing member results`);
      const reviewResponse = await this.callMember(
        chief,
        buildGenericReviewPrompt(task, plan, results),
        "json",
        task.budget?.max_output_tokens_per_call ?? 6000,
      );
      this.addEvent(
        run,
        "model_response_received",
        { phase: "final_review", content: reviewResponse.content, usage: reviewResponse.usage },
        chief.id,
      );
      await this.store.save(run);
      const report = await this.parseOrRepairTaskReport(
        task,
        chief,
        reviewResponse.content,
        run,
      );
      run.final_report = report;
      run.review_outcome = deriveReviewOutcome(report);
      this.addEvent(run, "final_review_completed", report, chief.id);
      const independentReviewer = this.resolveIndependentReviewer(chief.id);
      if (independentReviewer) {
        this.progress("reviewing", `${independentReviewer.id} is independently reviewing the chief report`);
        const independentResponse = await this.callMember(
          independentReviewer,
          buildIndependentReviewPrompt(task, report),
          "json",
          task.budget?.max_output_tokens_per_call ?? 2000,
        );
        this.addEvent(run, "model_response_received", {
          phase: "independent_review", content: independentResponse.content,
          usage: independentResponse.usage,
        }, independentReviewer.id);
        const independentReview = parseIndependentReview(independentResponse.content, independentReviewer.id);
        run.independent_review = independentReview;
        run.review_outcome = independentReview.outcome;
        this.addEvent(run, "final_review_completed", independentReview, independentReviewer.id);
      }
      run.status = "completed";
      run.usage = aggregateRunUsage(run);
      run.completed_at = this.clock.now().toISOString();
      this.addEvent(run, "run_completed", { artifact: "task_report" });
      await this.store.save(run);
      this.progress("completed", `run ${run.id} completed`);
      return run;
    } catch (error) {
      if (this.control.signal?.aborted) {
        run.status = "cancelled";
        run.completed_at = this.clock.now().toISOString();
        run.error = "Run cancelled by user";
        run.failure = attributeFailure(run.error);
        this.addEvent(run, "run_cancelled", { reason: run.error });
        await this.store.save(run);
        throw new Error(run.error);
      }
      run.status = "failed";
      run.completed_at = this.clock.now().toISOString();
      run.error = error instanceof Error ? error.message : String(error);
      run.failure = attributeFailure(error);
      this.addEvent(run, "run_failed", { error: run.error });
      await this.store.save(run);
      throw error;
    }
  }

  private progress(phase: RuntimeProgressPhase, message: string): void {
    this.observer.onProgress?.({ phase, message });
  }

  private resolveChief(overrideChief?: string): AgentConfig {
    const configuredChief = overrideChief ?? this.config.tribe.tribe.chief;
    const chief = configuredChief
      ? this.members.get(configuredChief)
      : [...this.members.values()].find((member) =>
          member.eligible_roles.includes("chief"),
        );

    if (!chief) {
      throw new Error("Tribe has no chief member");
    }
    if (chief.status === "inactive" || chief.status === "retired") {
      throw new Error(`Chief member is not available: ${chief.id}`);
    }
    return chief;
  }

  private resolveIndependentReviewer(chiefId: string): AgentConfig | undefined {
    return [...this.members.values()]
      .filter((member) => member.id !== chiefId && member.eligible_roles.includes("reviewer") && member.status !== "inactive" && member.status !== "retired")
      .sort((left, right) => (right.profile.review ?? 0) - (left.profile.review ?? 0))[0];
  }

  private createRun(task: TribeTask, chiefMemberId: string): TribeRun {
    const startedAt = this.clock.now().toISOString();
    return {
      schema_version: 2,
      id: this.clock.id(),
      tribe_id: this.config.tribe.tribe.id,
      task,
      task_analysis: analyzeTribeTask(task),
      member_versions: [...this.members.values()].map((member) => ({
        member_id: member.id,
        member_version: member.version ?? 1,
        model: member.model,
        skill_versions: Object.fromEntries(
          (member.skills ?? []).map((skill) => [skill, 1]),
        ),
      })),
      chief_member_id: chiefMemberId,
      status: "running",
      started_at: startedAt,
      work_results: [],
      events: [
        {
          type: "run_started",
          at: startedAt,
          payload: { task_id: task.id },
        },
      ],
    };
  }

  private async executeAssignment(
    task: TribeTask,
    assignment: WorkAssignment,
  ): Promise<WorkResult> {
    const member = this.members.get(assignment.member_id);
    if (!member) {
      throw new Error(`Chief assigned unknown member: ${assignment.member_id}`);
    }
    const response = await this.callMember(
      member,
      buildMemberWorkPrompt(task, assignment, member),
      "text",
      task.budget?.max_output_tokens_per_call,
    );
    return {
      assignment_id: assignment.id,
      member_id: member.id,
      content: response.content,
      usage: response.usage,
    };
  }

  private async callMember(
    member: AgentConfig,
    userPrompt: string,
    responseFormat: "text" | "json",
    maxTokens?: number,
  ): Promise<ModelResponse> {
    const provider = this.providers.get(member.provider);
    const requestedOutput = maxTokens ?? (responseFormat === "json" ? 6000 : 1200);
    const estimatedInput = Math.ceil(userPrompt.length / 2);
    let allowedOutput = requestedOutput;
    let reservation = 0;
    if (this.tokenBudgetLimit !== undefined) {
      const remaining = this.tokenBudgetLimit - this.tokensUsed - this.tokensReserved;
      allowedOutput = Math.min(requestedOutput, remaining - estimatedInput);
      if (allowedOutput < 128) {
        throw new Error(`Run token budget exhausted before calling ${member.id}: ${remaining} remaining`);
      }
      reservation = estimatedInput + allowedOutput;
      this.tokensReserved += reservation;
    }
    try {
      const response = await provider.generate({
      memberId: member.id,
      model: member.model,
      messages: [
        {
          role: "system",
          content: member.persona ?? `你是部落成员 ${member.name ?? member.id}。`,
        },
        { role: "user", content: userPrompt },
      ],
      responseFormat,
      maxTokens: allowedOutput,
      signal: this.control.signal,
      });
      this.tokensUsed += response.usage?.totalTokens
        ?? estimatedInput + Math.ceil(response.content.length / 2);
      if (this.tokenBudgetLimit !== undefined && this.tokensUsed > this.tokenBudgetLimit) {
        throw new Error(`Run token budget exceeded: ${this.tokensUsed} > ${this.tokenBudgetLimit}`);
      }
      return response;
    } finally {
      this.tokensReserved -= reservation;
    }
  }

  private async parseOrRepairTaskReport(
    task: TribeTask,
    chief: AgentConfig,
    content: string,
    run: TribeRun,
  ): Promise<TaskReport> {
    try {
      const report = parseTaskReport(content);
      validateTaskReport(report, task);
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.progress("repairing", `chief is repairing the final report: ${message}`);
      const repaired = await this.callMember(
        chief,
        buildReportRepairPrompt(task, content, message),
        "json",
        task.budget?.max_output_tokens_per_call,
      );
      this.addEvent(
        run,
        "model_response_received",
        {
          phase: "final_review_repair",
          repair_reason: message,
          content: repaired.content,
          usage: repaired.usage,
        },
        chief.id,
      );
      await this.store.save(run);
      const report = parseTaskReport(repaired.content);
      validateTaskReport(report, task);
      return report;
    }
  }

  private async parseOrRepairStaffingPlan(
    task: TribeTask,
    chief: AgentConfig,
    content: string,
    run: TribeRun,
    minimumAssignments: number,
  ): Promise<StaffingPlan> {
    try {
      const plan = parseStaffingPlan(content);
      this.validatePlan(plan, chief.id, minimumAssignments, task.budget?.max_members);
      return this.addStaffingEvidence(plan, task, chief.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.progress("repairing", `chief is repairing the staffing plan: ${message}`);
      const repaired = await this.callMember(
        chief,
        buildPlanRepairPrompt(
          task,
          chief,
          [...this.members.values()],
          content,
          message,
          minimumAssignments,
        ),
        "json",
        task.budget?.max_output_tokens_per_call ?? 6000,
      );
      this.addEvent(
        run,
        "model_response_received",
        {
          phase: "planning_repair",
          repair_reason: message,
          content: repaired.content,
          usage: repaired.usage,
        },
        chief.id,
      );
      await this.store.save(run);
      const plan = parseStaffingPlan(repaired.content);
      this.validatePlan(plan, chief.id, minimumAssignments, task.budget?.max_members);
      return this.addStaffingEvidence(plan, task, chief.id);
    }
  }

  private validatePlan(
    plan: StaffingPlan,
    chiefId: string,
    minimumAssignments: number,
    maxMembers?: number,
  ): void {
    if (plan.assignments.length === 0) {
      throw new Error("Chief produced an empty staffing plan");
    }
    const assignmentIds = new Set<string>();
    for (const assignment of plan.assignments) {
      if (!this.members.has(assignment.member_id)) {
        throw new Error(`Chief assigned unknown member: ${assignment.member_id}`);
      }
      const assignedMember = this.members.get(assignment.member_id);
      if (
        assignedMember?.status === "inactive" ||
        assignedMember?.status === "retired"
      ) {
        throw new Error(
          `Chief assigned unavailable member: ${assignment.member_id}`,
        );
      }
      if (assignment.member_id === chiefId) {
        throw new Error("Chief must delegate this onboarding task to other members");
      }
      if (assignmentIds.has(assignment.id)) {
        throw new Error(`Duplicate assignment id: ${assignment.id}`);
      }
      assignmentIds.add(assignment.id);
    }
    if (plan.assignments.length < minimumAssignments) {
      throw new Error(
        `Chief must delegate this task to at least ${minimumAssignments} member(s)`,
      );
    }
    const selectedMembers = new Set(plan.assignments.map((item) => item.member_id));
    if (maxMembers !== undefined && selectedMembers.size > maxMembers) {
      throw new Error(`Staffing plan exceeds max_members budget: ${selectedMembers.size} > ${maxMembers}`);
    }
  }

  private addStaffingEvidence(plan: StaffingPlan, task: TribeTask, chiefId: string): StaffingPlan {
    const required = analyzeTribeTask(task).required_capabilities;
    const selected = new Set(plan.assignments.map((item) => item.member_id));
    plan.candidate_ranking = [...this.members.values()]
      .filter((member) => member.id !== chiefId && member.status !== "inactive" && member.status !== "retired")
      .map((member) => {
        const scores = required
          .map((capability) => member.profile[capability as keyof typeof member.profile])
          .filter((score): score is number => score !== undefined);
        const capabilityMatch = scores.length
          ? scores.reduce((sum, score) => sum + score, 0) / scores.length
          : 0;
        const history = task.member_performance?.[member.id];
        const historicalAcceptance = history?.runs ? history.acceptance_rate : null;
        const costEfficiency = member.profile.cost ?? 0.5;
        const score = capabilityMatch * 0.7 + (historicalAcceptance ?? 0.5) * 0.2 + costEfficiency * 0.1;
        return {
          member_id: member.id,
          score: Math.round(score * 1000) / 1000,
          capability_match: Math.round(capabilityMatch * 1000) / 1000,
          historical_acceptance: historicalAcceptance,
          cost_efficiency: costEfficiency,
          selected: selected.has(member.id),
          reason: selected.has(member.id)
            ? "Chief selected this member; Runtime recorded comparative evidence"
            : "Candidate retained for comparison but not selected by Chief",
        };
      })
      .sort((left, right) => right.score - left.score);
    for (const assignment of plan.assignments) {
      const profile = this.members.get(assignment.member_id)?.profile ?? {};
      const scores = required
        .map((capability) => profile[capability as keyof typeof profile])
        .filter((score): score is number => score !== undefined);
      assignment.selection_score = scores.length
        ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 1000) / 1000
        : 0;
      assignment.cost_efficiency = profile.cost ?? 0.5;
    }
    return plan;
  }

  private addEvent(
    run: TribeRun,
    type: RunEvent["type"],
    payload: unknown,
    memberId?: string,
  ): void {
    run.events.push({
      type,
      at: this.clock.now().toISOString(),
      member_id: memberId,
      payload,
    });
  }
}

function buildChiefPlanningPrompt(
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

function buildGenericPlanningPrompt(
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

function buildPlanRepairPrompt(
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

function buildMemberWorkPrompt(
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

function buildGenericReviewPrompt(
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

function buildIndependentReviewPrompt(task: TribeTask, report: TaskReport): string {
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

function buildReportRepairPrompt(
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

function buildChiefReviewPrompt(
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

function parseStaffingPlan(content: string): StaffingPlan {
  const value = parseJsonObject(content, "staffing plan") as Partial<StaffingPlan>;
  if (typeof value.summary !== "string" || !Array.isArray(value.assignments)) {
    throw new Error("Chief returned an invalid staffing plan");
  }
  for (const assignment of value.assignments) {
    if (
      !assignment ||
      typeof assignment.id !== "string" ||
      typeof assignment.member_id !== "string" ||
      typeof assignment.role !== "string" ||
      typeof assignment.instruction !== "string" ||
      !Array.isArray(assignment.acceptance) ||
      !Array.isArray(assignment.skills) ||
      typeof assignment.assignment_reason !== "string" ||
      !Array.isArray(assignment.selection_factors)
    ) {
      throw new Error("Chief returned an invalid work assignment");
    }
  }
  return value as StaffingPlan;
}


function parseExamPaper(content: string): ExamPaper {
  return parseJsonObject(content, "exam paper") as ExamPaper;
}

function parseTaskReport(content: string): TaskReport {
  return parseJsonObject(content, "task report") as TaskReport;
}

function parseIndependentReview(content: string, reviewerMemberId: string): IndependentReview {
  const value = parseJsonObject(content, "independent review") as Partial<IndependentReview>;
  if (!value || !["accepted", "partial", "rejected"].includes(value.outcome ?? "") || typeof value.rationale !== "string" || !Array.isArray(value.issues)) {
    throw new Error("Independent reviewer returned an invalid review");
  }
  return { reviewer_member_id: reviewerMemberId, outcome: value.outcome!, rationale: value.rationale, issues: value.issues };
}

function validateExamPaper(exam: ExamPaper): void {
  if (
    typeof exam.title !== "string" ||
    typeof exam.instructions !== "string" ||
    !Array.isArray(exam.questions) ||
    exam.questions.length !== 3
  ) {
    throw new Error("Chief review must produce exactly three exam questions");
  }
  for (const question of exam.questions) {
    if (
      typeof question.id !== "number" ||
      typeof question.prompt !== "string" ||
      typeof question.answer !== "string" ||
      typeof question.rationale !== "string" ||
      typeof question.author_member_id !== "string"
    ) {
      throw new Error("Chief review produced an invalid exam question");
    }
  }
}

function validateGenericTask(task: TribeTask): void {
  if (!task.id || !task.goal.trim()) {
    throw new Error("Generic task requires id and goal");
  }
  if (!task.workspace || task.workspace.files.length === 0) {
    throw new Error("Generic task requires a non-empty workspace snapshot");
  }
  if (!task.constraints?.read_only) {
    throw new Error("Generic task currently supports read-only mode only");
  }
  if (task.acceptance.length === 0) {
    throw new Error("Generic task requires at least one acceptance criterion");
  }
}

function validateTaskReport(report: TaskReport, task: TribeTask): void {
  if (
    typeof report.title !== "string" ||
    typeof report.summary !== "string" ||
    !Array.isArray(report.findings) ||
    report.findings.length === 0 ||
    !Array.isArray(report.recommendations) ||
    !Array.isArray(report.acceptance_review)
  ) {
    throw new Error("Chief returned an invalid task report");
  }
  const workspacePaths = task.workspace?.files.map((file) => file.path) ?? [];
  for (const finding of report.findings) {
    if (
      typeof finding.claim !== "string" ||
      !Array.isArray(finding.evidence) ||
      finding.evidence.length === 0 ||
      finding.evidence.some((evidence) => typeof evidence !== "string") ||
      !finding.evidence.some((evidence) =>
        workspacePaths.some((path) => evidence.includes(path)),
      )
    ) {
      throw new Error("Every report finding must cite a workspace file");
    }
  }
  for (const recommendation of report.recommendations) {
    if (
      !["high", "medium", "low"].includes(recommendation.priority) ||
      typeof recommendation.action !== "string" ||
      typeof recommendation.reason !== "string"
    ) {
      throw new Error("Chief returned an invalid recommendation");
    }
  }
  for (const criterion of task.acceptance) {
    const review = report.acceptance_review.find(
      (item) => item.criterion === criterion,
    );
    if (
      !review ||
      !["passed", "partial", "failed"].includes(review.status) ||
      typeof review.evidence !== "string"
    ) {
      throw new Error(`Chief did not review acceptance criterion: ${criterion}`);
    }
  }
}

function formatWorkspaceForPrompt(task: TribeTask): string {
  if (!task.workspace) {
    return "[]";
  }
  return JSON.stringify({
    root_label: task.workspace.root,
    omitted_files: task.workspace.omitted_files,
    total_bytes: task.workspace.total_bytes,
    files: task.workspace.files,
  });
}

function parseJsonObject(content: string, label: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Fall through to the actionable error below.
      }
    }
    throw new Error(`Failed to parse ${label} JSON`);
  }
}

function aggregateRunUsage(run: TribeRun) {
  const modelResponses = run.events.filter(
    (event) => event.type === "model_response_received",
  );
  const usages = [
    ...run.work_results.map((result) => result.usage),
    ...modelResponses.map(
      (event) => (event.payload as { usage?: ModelResponse["usage"] }).usage,
    ),
  ].filter((usage) => usage !== undefined);
  return {
    calls: run.work_results.length + modelResponses.length,
    input_tokens: usages.reduce(
      (sum, usage) => sum + (usage.inputTokens ?? 0),
      0,
    ),
    output_tokens: usages.reduce(
      (sum, usage) => sum + (usage.outputTokens ?? 0),
      0,
    ),
    total_tokens: usages.reduce(
      (sum, usage) => sum + (usage.totalTokens ?? 0),
      0,
    ),
  };
}

function deriveReviewOutcome(
  report: TaskReport,
): "accepted" | "partial" | "rejected" {
  if (report.acceptance_review.some((item) => item.status === "failed")) {
    return "rejected";
  }
  if (report.acceptance_review.some((item) => item.status === "partial")) {
    return "partial";
  }
  return "accepted";
}
