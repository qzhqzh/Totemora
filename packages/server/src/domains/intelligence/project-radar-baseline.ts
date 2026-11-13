import type { IntelligenceCandidate } from "../../intelligence-candidate-store";
import type { ProjectRadarEvaluation, ProjectRadarEvidence, ProjectRadarProject } from "./project-radar-types";

export const PROJECT_RADAR_RULE_MODEL = "rules:project-focus-v1";

/** Literal evidence matching; scores here are rule matches, never model probabilities. */
export function evaluateProjectRadarBaseline(input: {
  candidate: IntelligenceCandidate; projects: ProjectRadarProject[];
  evidence: ProjectRadarEvidence[]; same_event: boolean;
}): Pick<ProjectRadarEvaluation, "evaluation_method" | "projects" | "decision_confidence" | "evidence_quality"
  | "novelty" | "urgency" | "route" | "reason" | "model"> {
  const text = input.evidence.map((item) => `${item.title}\n${item.text}`).join("\n").normalize("NFKC").toLowerCase();
  const projects = input.projects.filter((project) => project.enabled).map((project) => {
    const excluded = project.exclude.some((term) => matches(text, term));
    const terms = [...new Set([project.name, ...project.focus])];
    const matched = excluded ? [] : terms.filter((term) => matches(text, term));
    return { project_id: project.id, relevance: matched.length ? 1 : 0, confidence: null, matched_terms: matched };
  });
  const base = { evaluation_method: "rules" as const, projects, decision_confidence: null,
    evidence_quality: input.evidence.length ? 1 : 0, novelty: input.candidate.scores.novelty,
    urgency: 0, model: PROJECT_RADAR_RULE_MODEL };
  if (!input.evidence.length) return { ...base, route: "review", reason: "缺少对应采集材料；规则未作事实判断" };
  if (input.candidate.scores.confidence < 0.55) return { ...base, route: "review", reason: "原候选事实可信度门槛未通过" };
  if (["held", "failed", "delivery_unknown"].includes(input.candidate.status)) {
    return { ...base, route: "hold", reason: "原候选未具备发送资格，规则不能提升其状态" };
  }
  if (input.candidate.duplicate_of || (input.same_event && (!input.candidate.is_update || base.novelty < 0.75))) {
    return { ...base, route: "hold", reason: "重复事件；规则无法确认有实质新事实" };
  }
  if (base.novelty < 0.55) return { ...base, route: "hold", reason: "原候选新颖度未达到精选门槛" };
  const matched = [...new Set(projects.flatMap((project) => project.matched_terms))];
  return matched.length
    ? { ...base, route: "digest", reason: `采集材料命中关注词：${matched.slice(0, 4).join("、")}；仅为规则匹配，建议核实适用性` }
    : { ...base, route: "hold", reason: "未命中启用项目关注词，或命中排除项" };
}

function matches(text: string, value: string): boolean {
  const term = value.normalize("NFKC").trim().toLowerCase();
  if (term.length < 2) return false;
  if (!/^[a-z0-9 ._+-]+$/i.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
}
