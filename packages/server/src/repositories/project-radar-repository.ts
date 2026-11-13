import type { CandidateFeedbackSignal, IntelligenceCandidate } from "../intelligence-candidate-store";
import { StateDatabase } from "../state-database";
import { defaultProjectRadarSettings, parseProjectRadarSettings } from "../domains/intelligence/project-radar-policy";
import type { ProjectRadarEvaluation, ProjectRadarEvidence, ProjectRadarSettings, ProjectRadarUsage } from "../domains/intelligence/project-radar-types";

export class ProjectRadarRepository {
  private readonly state: StateDatabase;
  constructor(dataDir: string) { this.state = StateDatabase.open(dataDir); }

  getSettings(): ProjectRadarSettings {
    const row = this.state.db.query("SELECT settings_json FROM project_radar_settings WHERE id=1").get() as { settings_json: string } | null;
    if (!row) return defaultProjectRadarSettings();
    const value = JSON.parse(row.settings_json) as ProjectRadarSettings;
    return parseProjectRadarSettings(value, new Date(value.updated_at));
  }
  saveSettings(value: unknown, now = new Date()): ProjectRadarSettings {
    const settings = parseProjectRadarSettings(value, now);
    this.state.db.query(`INSERT INTO project_radar_settings(id,mode,settings_json,updated_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,settings_json=excluded.settings_json,updated_at=excluded.updated_at`)
      .run(settings.mode, JSON.stringify(settings), settings.updated_at);
    return settings;
  }
  listEvaluations(limit = 100): ProjectRadarEvaluation[] {
    return (this.state.db.query("SELECT evaluation_json FROM project_radar_evaluations ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(boundedLimit(limit, 500)) as Array<{ evaluation_json: string }>).map(decode);
  }
  getEvaluation(id: string): ProjectRadarEvaluation | undefined {
    const row = this.state.db.query("SELECT evaluation_json FROM project_radar_evaluations WHERE id=?").get(id) as { evaluation_json: string } | null;
    return row ? decode(row) : undefined;
  }
  findCached(candidateId: string, settingsFingerprint: string, inputFingerprint: string): ProjectRadarEvaluation | undefined {
    const row = this.state.db.query(`SELECT evaluation_json FROM project_radar_evaluations
      WHERE candidate_id=? AND settings_fingerprint=? AND input_fingerprint=?`)
      .get(candidateId, settingsFingerprint, inputFingerprint) as { evaluation_json: string } | null;
    return row ? decode(row) : undefined;
  }
  evaluatedCandidateIds(settingsFingerprint: string, since: string): Set<string> {
    const rows = this.state.db.query(`SELECT DISTINCT candidate_id FROM project_radar_evaluations
      WHERE settings_fingerprint=? AND created_at>=? ORDER BY created_at DESC LIMIT 1000`)
      .all(settingsFingerprint, since) as Array<{ candidate_id: string }>;
    return new Set(rows.map((row) => row.candidate_id));
  }
  attemptedCandidateIds(day: string): Set<string> {
    const rows = this.state.db.query("SELECT DISTINCT candidate_id FROM project_radar_usage WHERE day=? LIMIT 500")
      .all(day) as Array<{ candidate_id: string }>;
    return new Set(rows.map((row) => row.candidate_id));
  }
  hasBudgetAttempt(day: string, cacheKey: string): boolean {
    return Boolean(this.state.db.query("SELECT id FROM project_radar_usage WHERE day=? AND cache_key=?").get(day, cacheKey));
  }
  saveEvaluation(evaluation: ProjectRadarEvaluation): ProjectRadarEvaluation {
    this.state.db.query(`INSERT OR IGNORE INTO project_radar_evaluations(
      id,candidate_id,route,settings_fingerprint,input_fingerprint,evaluation_json,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(evaluation.id, evaluation.candidate_id, evaluation.route, evaluation.settings_fingerprint,
        evaluation.input_fingerprint, JSON.stringify(evaluation), evaluation.created_at);
    return this.findCached(evaluation.candidate_id, evaluation.settings_fingerprint, evaluation.input_fingerprint)!;
  }
  ruleUsage(day: string): number {
    const start = new Date(`${day}T00:00:00+08:00`).toISOString();
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    return (this.state.db.query(`SELECT COUNT(*) count FROM project_radar_evaluations
      WHERE created_at>=? AND created_at<? AND json_extract(evaluation_json,'$.evaluation_method')='rules'`)
      .get(start, end) as { count: number }).count;
  }
  saveRuleEvaluation(evaluation: ProjectRadarEvaluation, day: string, limit: number): ProjectRadarEvaluation | undefined {
    return this.state.db.transaction(() => {
      const cached = this.findCached(evaluation.candidate_id, evaluation.settings_fingerprint, evaluation.input_fingerprint);
      if (cached) return cached;
      if (this.ruleUsage(day) + this.getUsage(day).evaluations >= limit) return undefined;
      return this.saveEvaluation(evaluation);
    }).immediate();
  }
  getUsage(day: string): ProjectRadarUsage {
    const row = this.state.db.query(`SELECT COUNT(*) evaluations,COALESCE(SUM(input_tokens),0) input_tokens,
      COALESCE(SUM(status='failed'),0) failures,COALESCE(SUM(status='reserved'),0) pending
      FROM project_radar_usage WHERE day=?`).get(day) as Omit<ProjectRadarUsage, "day">;
    return { day, ...row };
  }
  feedbackCounts(): Partial<Record<CandidateFeedbackSignal, number>> {
    const rows = this.state.db.query(`SELECT signal,COUNT(*) count FROM candidate_feedback
      WHERE candidate_id IN (SELECT candidate_id FROM project_radar_evaluations ORDER BY created_at DESC LIMIT 500)
      GROUP BY signal`).all() as Array<{ signal: CandidateFeedbackSignal; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.signal, row.count]));
  }
  reserveBudget(input: { day: string; candidate_id: string; cache_key: string; input_tokens: number;
    evaluation_limit: number; token_limit: number; now?: Date }): { id: string } | undefined {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || !/^[a-f0-9]{64}$/.test(input.cache_key)
      || !Number.isSafeInteger(input.input_tokens) || input.input_tokens < 1
      || !Number.isSafeInteger(input.evaluation_limit) || input.evaluation_limit < 1 || input.evaluation_limit > 500
      || !Number.isSafeInteger(input.token_limit) || input.token_limit < 1_000 || input.token_limit > 250_000) throw new Error("Invalid project radar budget reservation");
    return this.state.db.transaction(() => {
      const usage = this.getUsage(input.day);
      if (usage.evaluations + this.ruleUsage(input.day) >= input.evaluation_limit || usage.input_tokens + input.input_tokens > input.token_limit) return undefined;
      const id = crypto.randomUUID();
      const result = this.state.db.query(`INSERT OR IGNORE INTO project_radar_usage(
        id,day,cache_key,candidate_id,status,input_tokens,reserved_tokens,created_at) VALUES(?,?,?,?,'reserved',?,?,?)`)
        .run(id, input.day, input.cache_key, input.candidate_id, input.input_tokens, input.input_tokens, (input.now ?? new Date()).toISOString());
      return result.changes === 1 ? { id } : undefined;
    }).immediate();
  }
  settleBudget(id: string, actualTokens?: number, failed = false, error?: string): void {
    const tokens = typeof actualTokens === "number" && Number.isSafeInteger(actualTokens) && actualTokens >= 0 ? actualTokens : null;
    this.state.db.query(`UPDATE project_radar_usage SET status=?,input_tokens=COALESCE(?,reserved_tokens),error=?,completed_at=?
      WHERE id=? AND status='reserved'`)
      .run(failed ? "failed" : "completed", tokens, failed ? (error ?? "Evaluation failed").slice(0, 500) : null, new Date().toISOString(), id);
  }
  getEvidence(candidate: IntelligenceCandidate): ProjectRadarEvidence[] {
    const namespace = candidate.domain === "finance" ? "finance_intelligence_briefs" : "intelligence_briefs";
    // Reject oversized persisted inputs before decoding; never load unrelated brief histories.
    const row = this.state.db.query(`SELECT payload_json FROM records
      WHERE namespace=? AND id=? AND length(CAST(payload_json AS BLOB))<=1048576`).get(namespace, candidate.scan_id) as { payload_json: string } | null;
    if (!row) return [];
    const brief: unknown = JSON.parse(row.payload_json);
    if (!brief || typeof brief !== "object" || !Array.isArray((brief as { sources?: unknown }).sources)) return [];
    return ((brief as { sources: unknown[] }).sources).slice(0, 500).flatMap((source) => {
      if (!source || typeof source !== "object") return [];
      const item = source as Record<string, unknown>;
      if (item.link !== candidate.url || typeof item.title !== "string" || typeof item.summary !== "string" || !item.summary.trim()) return [];
      if (!safeUrl(candidate.url)) return [];
      return [{ title: item.title.slice(0, 500), url: candidate.url, text: item.summary.slice(0, 6_000),
        source: typeof item.source === "string" ? item.source.slice(0, 200) : candidate.source.slice(0, 200),
        published_at: typeof item.published_at === "string" ? item.published_at.slice(0, 50) : undefined }];
    }).slice(0, 3);
  }
}
function decode(row: { evaluation_json: string }): ProjectRadarEvaluation { return JSON.parse(row.evaluation_json) as ProjectRadarEvaluation; }
function boundedLimit(limit: number, maximum: number): number { return Number.isSafeInteger(limit) ? Math.max(1, Math.min(maximum, limit)) : 100; }
function safeUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && value.length <= 2_048; }
  catch { return false; }
}
