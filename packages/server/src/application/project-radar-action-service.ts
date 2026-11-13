import type { IntelligenceCandidate } from "../intelligence-candidate-store";
import type { ProjectRadarEvaluation, ProjectRadarEvidence, ProjectRadarProject } from "../domains/intelligence/project-radar-types";
import { parseProjectRadarAction, parseProjectRadarActionDecision, parseProjectRadarLifelineTarget, safeProjectRadarEvidenceUrl,
  ProjectRadarActionConflictError, ProjectRadarActionInputError, ProjectRadarActionNotFoundError,
  type ProjectRadarAction, type ProjectRadarActionEvidence, type ProjectRadarActionHandoff, type ProjectRadarLifelineTarget } from "../domains/intelligence/project-radar-action";
import type { ProjectRadarActionRepository } from "../repositories/project-radar-action-repository";

export interface ProjectRadarActionServiceOptions {
  repository: ProjectRadarActionRepository;
  now?: () => Date;
  /** Explicitly verified Lifeline identifiers, keyed by the local radar project id. */
  lifelineTargets?: Readonly<Record<string, ProjectRadarLifelineTarget>>;
}
export interface MaterializeProjectRadarActionsInput {
  evaluation: ProjectRadarEvaluation;
  candidate: IntelligenceCandidate;
  projects: ProjectRadarProject[];
  evidence: ProjectRadarEvidence[];
}

export class ProjectRadarActionService {
  constructor(private readonly options: ProjectRadarActionServiceOptions) {}

  materialize({ evaluation, candidate, projects, evidence }: MaterializeProjectRadarActionsInput): ProjectRadarAction[] {
    if (evaluation.candidate_id !== candidate.id) throw new ProjectRadarActionInputError("evaluation candidate does not match action candidate");
    const method = evaluation.evaluation_method ?? "jev";
    if (!["digest", "immediate"].includes(evaluation.route) || !factGate(candidate)
      || !atLeast(evaluation.evidence_quality, 0.6) || !atLeast(evaluation.novelty, 0.55)
      || (method === "jev" && !atLeast(evaluation.decision_confidence, 0.65))) return [];
    const originals = originalEvidence(candidate, evidence);
    if (!originals.length) return [];
    const result: ProjectRadarAction[] = [];
    for (const project of projects.filter((card) => card.enabled)) {
      const match = evaluation.projects.find((item) => item.project_id === project.id);
      if (!match || !atLeast(match.relevance, 0.65) || (method === "jev" && !atLeast(match.confidence, 0.65))) continue;
      const methodDescription = method === "rules" ? "规则匹配仅表示文本关联，不代表模型信心" : "Jev 评估仅提供项目关联判断，原文陈述仍需核实";
      const action = parseProjectRadarAction({
        id: crypto.randomUUID(), candidate_id: candidate.id, evaluation_id: evaluation.id, project_id: project.id,
        project_name: project.name, project_goal: project.goal,
        title: `核实「${originals[0].title.slice(0, 450)}」对 ${project.name} 的适用性`,
        rationale: `原始材料与项目「${project.name}」的关注方向有关；目标是「${project.goal}」。${methodDescription}。`,
        next_step: `建议核实：阅读所附原文及其限制，对照项目目标「${project.goal}」记录适用条件与缺失信息；据此决定是否安排小范围验证。`,
        acceptance_criteria: ["记录原文链接和对应段落，区分来源陈述与已经核实的事实。",
          `对照项目目标「${project.goal}」说明适用条件、局限和待确认事项。`, "给出继续验证或暂缓的结论及依据；若继续，列出最小验证范围和成功条件。"],
        evidence: originals, method, status: "proposed", created_at: (this.options.now?.() ?? new Date()).toISOString(), decided_at: null, decision_source: null,
      });
      result.push(this.options.repository.saveProposal(action));
    }
    return result;
  }

  list(limit?: number): ProjectRadarAction[] { return this.options.repository.list(limit); }

  decide(id: string, input: unknown): ProjectRadarAction {
    return this.options.repository.decide(id, parseProjectRadarActionDecision(input), this.options.now?.() ?? new Date());
  }

  handoff(id: string): ProjectRadarActionHandoff {
    const action = this.options.repository.get(id);
    if (!action) throw new ProjectRadarActionNotFoundError("project radar action not found");
    if (action.status !== "accepted") throw new ProjectRadarActionConflictError("only an accepted action can become a Lifeline draft");
    const configured = this.options.lifelineTargets?.[action.project_id];
    const target = configured === undefined ? undefined : parseProjectRadarLifelineTarget(configured);
    return {
      version: 1, destination: "lifeline", status: "draft", submitted: false, ready: Boolean(target),
      project_id: target?.project_id ?? null, phase_id: target?.phase_id ?? null, missing_fields: target ? [] : ["project_id", "phase_id"],
      title: action.title, description: `${action.rationale}\n\n${action.next_step}`,
      acceptance_criteria: action.acceptance_criteria, evidence: action.evidence,
      source: { system: "totemora", action_id: action.id, candidate_id: action.candidate_id, evaluation_id: action.evaluation_id,
        radar_project_id: action.project_id, radar_project_name: action.project_name },
    };
  }
}
function atLeast(value: number | null, minimum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= 1;
}
function factGate(candidate: IntelligenceCandidate): boolean {
  return atLeast(candidate.scores.confidence, 0.55) && atLeast(candidate.scores.novelty, 0.45) && !candidate.duplicate_of
    && ["queued", "pushing", "retry_wait", "channel_blocked", "pushed"].includes(candidate.status)
    && (candidate.domain !== "finance" || Boolean(candidate.evidence_tier && candidate.evidence_tier !== "S4"));
}
function originalEvidence(candidate: IntelligenceCandidate, evidence: ProjectRadarEvidence[]): ProjectRadarActionEvidence[] {
  if (!safeProjectRadarEvidenceUrl(candidate.url)) return [];
  return evidence.slice(0, 3).flatMap((source) => {
    if (source.url !== candidate.url || typeof source.text !== "string" || !source.text.trim()
      || typeof source.title !== "string" || !source.title.trim() || typeof source.source !== "string" || !source.source.trim()) return [];
    const title = clean(source.title, 500); const name = clean(source.source, 200); const excerpt = clean(source.text, 2_000);
    if (!title || !name || !excerpt) return [];
    // Keep the source's stated precision; a date alone is not an exact midnight timestamp.
    const published = source.published_at && source.published_at.length <= 40 && /^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(source.published_at)
      && Number.isFinite(Date.parse(source.published_at)) ? source.published_at : undefined;
    return [{ title, url: source.url, source: name, excerpt, ...(published ? { published_at: published } : {}) }];
  });
}
function clean(value: string, maximum: number): string { return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum); }
