export type ProjectRadarActionStatus = "proposed" | "accepted" | "dismissed";
export type ProjectRadarActionMethod = "rules" | "jev";
export type ProjectRadarActionDecisionSource = "web" | "telegram";

export interface ProjectRadarActionEvidence {
  title: string;
  url: string;
  source: string;
  excerpt: string;
  published_at?: string;
}
export interface ProjectRadarAction {
  id: string;
  candidate_id: string;
  evaluation_id: string;
  project_id: string;
  project_name: string;
  project_goal: string;
  title: string;
  rationale: string;
  next_step: string;
  acceptance_criteria: string[];
  evidence: ProjectRadarActionEvidence[];
  method: ProjectRadarActionMethod;
  status: ProjectRadarActionStatus;
  created_at: string;
  decided_at: string | null;
  decision_source: ProjectRadarActionDecisionSource | null;
}
export interface ProjectRadarActionDecision {
  decision: "accept" | "dismiss";
  idempotency_key: string;
  source: ProjectRadarActionDecisionSource;
}
export interface ProjectRadarLifelineTarget { project_id: string; phase_id: string }
export interface ProjectRadarActionHandoff {
  version: 1;
  destination: "lifeline";
  status: "draft";
  submitted: false;
  ready: boolean;
  project_id: string | null;
  phase_id: string | null;
  missing_fields: Array<"project_id" | "phase_id">;
  title: string;
  description: string;
  acceptance_criteria: string[];
  evidence: ProjectRadarActionEvidence[];
  source: { system: "totemora"; action_id: string; candidate_id: string; evaluation_id: string; radar_project_id: string; radar_project_name: string };
}
export class ProjectRadarActionInputError extends Error {}
export class ProjectRadarActionConflictError extends Error {}
export class ProjectRadarActionNotFoundError extends Error {}

export function parseProjectRadarActionDecision(value: unknown): ProjectRadarActionDecision {
  const input = object(value);
  exactKeys(input, ["decision", "idempotency_key", "source"]);
  if (input.decision !== "accept" && input.decision !== "dismiss") invalid("decision must be accept or dismiss");
  const source = input.source === undefined ? "web" : input.source;
  if (source !== "web" && source !== "telegram") invalid("source must be web or telegram");
  const idempotency_key = text(input.idempotency_key, "idempotency_key", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(idempotency_key)) invalid("invalid idempotency_key");
  return { decision: input.decision, idempotency_key, source };
}

export function parseProjectRadarAction(value: unknown): ProjectRadarAction {
  const input = object(value);
  exactKeys(input, ["id", "candidate_id", "evaluation_id", "project_id", "project_name", "project_goal", "title", "rationale", "next_step",
    "acceptance_criteria", "evidence", "method", "status", "created_at", "decided_at", "decision_source"]);
  const status = input.status;
  if (status !== "proposed" && status !== "accepted" && status !== "dismissed") invalid("invalid action status");
  if (input.method !== "rules" && input.method !== "jev") invalid("invalid action method");
  const decided_at = input.decided_at === null ? null : timestamp(input.decided_at, "decided_at");
  const source = input.decision_source;
  if (source !== null && source !== "web" && source !== "telegram") invalid("invalid decision_source");
  if ((status === "proposed" && (decided_at !== null || source !== null))
    || (status !== "proposed" && (decided_at === null || source === null))) invalid("incoherent action decision");
  if (!Array.isArray(input.acceptance_criteria) || input.acceptance_criteria.length < 1 || input.acceptance_criteria.length > 8) invalid("invalid acceptance_criteria");
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 3) invalid("invalid action evidence");
  const project_id = text(input.project_id, "project_id", 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project_id)) invalid("invalid project_id");
  const action: ProjectRadarAction = {
    id: parseProjectRadarActionId(input.id), candidate_id: identifier(input.candidate_id, "candidate_id"), evaluation_id: identifier(input.evaluation_id, "evaluation_id"),
    project_id, project_name: text(input.project_name, "project_name", 100), project_goal: text(input.project_goal, "project_goal", 1_000),
    title: text(input.title, "title", 600), rationale: text(input.rationale, "rationale", 2_000), next_step: text(input.next_step, "next_step", 2_500),
    acceptance_criteria: input.acceptance_criteria.map((item) => text(item, "acceptance_criteria", 1_500)),
    evidence: input.evidence.map(parseEvidence), method: input.method, status, created_at: timestamp(input.created_at, "created_at"),
    decided_at, decision_source: source,
  };
  if (Buffer.byteLength(JSON.stringify(action)) > 65_536) invalid("action is too large");
  return action;
}

export function parseProjectRadarActionId(value: unknown): string { return identifier(value, "action id"); }
export function parseProjectRadarLifelineTarget(value: unknown): ProjectRadarLifelineTarget {
  const input = object(value); exactKeys(input, ["project_id", "phase_id"]);
  return { project_id: identifier(input.project_id, "Lifeline project_id"), phase_id: identifier(input.phase_id, "Lifeline phase_id") };
}
export function safeProjectRadarEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 2_048 && !/[\u0000-\u0020\u007f]/u.test(value) && url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}
function parseEvidence(value: unknown): ProjectRadarActionEvidence {
  const input = object(value); exactKeys(input, ["title", "url", "source", "excerpt", "published_at"]);
  const url = text(input.url, "evidence.url", 2_048);
  if (!safeProjectRadarEvidenceUrl(url)) invalid("invalid evidence URL");
  return { title: text(input.title, "evidence.title", 500), url, source: text(input.source, "evidence.source", 200),
    excerpt: text(input.excerpt, "evidence.excerpt", 2_000),
    ...(input.published_at === undefined ? {} : { published_at: text(input.published_at, "evidence.published_at", 40) }) };
}
function identifier(value: unknown, name: string): string {
  const result = text(value, name, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid(`invalid ${name}`);
  return result;
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) invalid(`invalid ${name}`);
  return result;
}
function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`invalid ${name}`);
  return value.trim();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected object");
  return value as Record<string, unknown>;
}
function exactKeys(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) invalid("unknown action field");
}
function invalid(message: string): never { throw new ProjectRadarActionInputError(message); }
