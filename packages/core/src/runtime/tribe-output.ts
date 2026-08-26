import type { ModelResponse } from "../provider";
import type {
  ExamPaper,
  IndependentReview,
  StaffingPlan,
  TaskReport,
  TribeRun,
  TribeTask,
} from "./types";

export function parseStaffingPlan(content: string): StaffingPlan {
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

export function parseExamPaper(content: string): ExamPaper {
  return parseJsonObject(content, "exam paper") as ExamPaper;
}

export function parseTaskReport(content: string): TaskReport {
  return parseJsonObject(content, "task report") as TaskReport;
}

export function parseIndependentReview(content: string, reviewerMemberId: string): IndependentReview {
  const value = parseJsonObject(content, "independent review") as Partial<IndependentReview>;
  if (!value || !["accepted", "partial", "rejected"].includes(value.outcome ?? "")
    || typeof value.rationale !== "string" || !Array.isArray(value.issues)) {
    throw new Error("Independent reviewer returned an invalid review");
  }
  return {
    reviewer_member_id: reviewerMemberId,
    outcome: value.outcome!,
    rationale: value.rationale,
    issues: value.issues,
  };
}

export function validateExamPaper(exam: ExamPaper): void {
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

export function validateGenericTask(task: TribeTask): void {
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

export function validateTaskReport(report: TaskReport, task: TribeTask): void {
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

export function aggregateRunUsage(run: TribeRun) {
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

export function deriveReviewOutcome(
  report: TaskReport,
): "accepted" | "partial" | "rejected" {
  if (report.acceptance_review.some((item) => item.status === "failed")) return "rejected";
  if (report.acceptance_review.some((item) => item.status === "partial")) return "partial";
  return "accepted";
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
