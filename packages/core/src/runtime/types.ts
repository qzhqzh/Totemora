import type { ModelUsage } from "../provider";

export interface TribeTask {
  id: string;
  goal: string;
  context?: string[];
  acceptance: string[];
  workspace?: WorkspaceSnapshot;
  constraints?: TaskConstraints;
  budget?: TaskBudget;
  member_performance?: Record<string, MemberPerformanceSummary>;
}

export interface MemberPerformanceSummary {
  runs: number;
  accepted: number;
  acceptance_rate: number;
  failed: number;
}

export interface TaskAnalysis {
  type: TaskMode;
  features: string[];
  required_capabilities: string[];
  execution_enabled: boolean;
  reason: string;
}

export type TaskMode = "onboarding" | "answer" | "inspect" | "change" | "operate" | "continue";

export interface MemberVersionSnapshot {
  member_id: string;
  member_version: number;
  model: string;
  skill_versions: Record<string, number>;
}

export interface TaskConstraints {
  read_only: boolean;
}

export interface TaskBudget {
  max_context_bytes?: number;
  max_output_tokens_per_call?: number;
  max_members?: number;
  max_total_tokens?: number;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface WorkspaceSnapshot {
  root: string;
  files: WorkspaceFile[];
  omitted_files: number;
  total_bytes: number;
}

export interface WorkAssignment {
  id: string;
  member_id: string;
  role: string;
  instruction: string;
  acceptance: string[];
  skills: string[];
  assignment_reason: string;
  selection_factors: string[];
  selection_score?: number;
  cost_efficiency?: number;
}

export interface StaffingPlan {
  summary: string;
  assignments: WorkAssignment[];
  candidate_ranking?: StaffingCandidateEvidence[];
}

export interface StaffingCandidateEvidence {
  member_id: string;
  score: number;
  capability_match: number;
  historical_acceptance: number | null;
  cost_efficiency: number;
  selected: boolean;
  reason: string;
}

export interface WorkResult {
  assignment_id: string;
  member_id: string;
  content: string;
  usage?: ModelUsage;
}

export interface ExamQuestion {
  id: number;
  prompt: string;
  answer: string;
  rationale: string;
  author_member_id: string;
}

export interface ExamPaper {
  title: string;
  instructions: string;
  questions: ExamQuestion[];
}

export interface ReportFinding {
  claim: string;
  evidence: string[];
}

export interface ReportRecommendation {
  priority: "high" | "medium" | "low";
  action: string;
  reason: string;
}

export interface AcceptanceReviewItem {
  criterion: string;
  status: "passed" | "partial" | "failed";
  evidence: string;
}

export interface TaskReport {
  title: string;
  summary: string;
  findings: ReportFinding[];
  recommendations: ReportRecommendation[];
  acceptance_review: AcceptanceReviewItem[];
}

export interface IndependentReview {
  reviewer_member_id: string;
  outcome: "accepted" | "partial" | "rejected";
  rationale: string;
  issues: string[];
}

export interface RunUsageSummary {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface FailureAttribution {
  category: "provider" | "budget" | "output_validation" | "staffing" | "workspace" | "cancelled" | "unknown";
  retryable: boolean;
  owner: "provider" | "chief" | "member" | "runtime" | "user" | "unknown";
  summary: string;
}

export type RunEventType =
  | "run_started"
  | "model_response_received"
  | "plan_created"
  | "assignment_completed"
  | "final_review_completed"
  | "run_completed"
  | "run_cancelled"
  | "run_failed";

export interface RunEvent {
  type: RunEventType;
  at: string;
  member_id?: string;
  payload: unknown;
}

export interface TribeRun {
  schema_version: 2;
  id: string;
  tribe_id: string;
  task: TribeTask;
  task_analysis: TaskAnalysis;
  member_versions: MemberVersionSnapshot[];
  chief_member_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  review_outcome?: "accepted" | "partial" | "rejected";
  started_at: string;
  completed_at?: string;
  plan?: StaffingPlan;
  work_results: WorkResult[];
  final_artifact?: ExamPaper;
  final_report?: TaskReport;
  independent_review?: IndependentReview;
  usage?: RunUsageSummary;
  events: RunEvent[];
  error?: string;
  failure?: FailureAttribution;
}

export interface RunStore {
  save(run: TribeRun): Promise<void>;
}
