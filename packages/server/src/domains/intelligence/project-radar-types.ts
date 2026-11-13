import type { IntelligenceCandidate } from "../../intelligence-candidate-store";

export type ProjectRadarMode = "off" | "shadow" | "active";
export type ProjectRadarRoute = "immediate" | "digest" | "hold" | "review";
export interface ProjectRadarProject {
  id: string;
  name: string;
  goal: string;
  focus: string[];
  exclude: string[];
  enabled: boolean;
}
export interface ProjectRadarSettings {
  version: 1;
  mode: ProjectRadarMode;
  projects: ProjectRadarProject[];
  timezone: "Asia/Shanghai";
  digest_time: string;
  digest_limit: number;
  daily_evaluation_limit: number;
  daily_token_limit: number;
  updated_at: string;
}
export interface ProjectRadarEvaluation {
  id: string;
  candidate_id: string;
  baseline: { scores: IntelligenceCandidate["scores"]; status: IntelligenceCandidate["status"] };
  evaluation_method?: "jev" | "rules";
  projects: Array<{ project_id: string; relevance: number; confidence: number | null; matched_terms?: string[] }>;
  decision_confidence: number | null;
  evidence_quality: number;
  novelty: number;
  urgency: number;
  route: ProjectRadarRoute;
  reason: string;
  model: string;
  question_version: string;
  settings_fingerprint: string;
  input_fingerprint: string;
  created_at: string;
}
export interface ProjectRadarUsage {
  day: string;
  evaluations: number;
  input_tokens: number;
  failures: number;
  pending: number;
}
export interface ProjectRadarEvidence {
  title: string;
  url: string;
  text: string;
  source: string;
  published_at?: string;
}
export interface ProjectRadarReplayResult {
  evaluations: ProjectRadarEvaluation[];
  cached: number;
  failed: number;
  budget_exhausted: boolean;
  skipped: number;
}
