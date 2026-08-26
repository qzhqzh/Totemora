import type { AgentConfig, LocalConfigSet } from "../config";
import type { ModelResponse, ProviderRegistry } from "../provider";
import type {
  RunEvent,
  RunStore,
  StaffingPlan,
  TaskReport,
  TribeRun,
  TribeTask,
  WorkAssignment,
  WorkResult,
} from "./types";
import { analyzeTribeTask } from "./task-analyzer";
import { attributeFailure } from "./failure-attribution";
import {
  buildChiefPlanningPrompt,
  buildChiefReviewPrompt,
  buildGenericPlanningPrompt,
  buildGenericReviewPrompt,
  buildIndependentReviewPrompt,
  buildMemberWorkPrompt,
  buildPlanRepairPrompt,
  buildReportRepairPrompt,
} from "./tribe-prompts";
import {
  aggregateRunUsage,
  deriveReviewOutcome,
  parseExamPaper,
  parseIndependentReview,
  parseStaffingPlan,
  parseTaskReport,
  validateExamPaper,
  validateGenericTask,
  validateTaskReport,
} from "./tribe-output";
import { addStaffingEvidence, validateStaffingPlan } from "./tribe-staffing";

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
      validateStaffingPlan(plan, this.members, chief.id, minimumAssignments, task.budget?.max_members);
      return addStaffingEvidence(plan, task, this.members, chief.id);
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
      validateStaffingPlan(plan, this.members, chief.id, minimumAssignments, task.budget?.max_members);
      return addStaffingEvidence(plan, task, this.members, chief.id);
    }
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
