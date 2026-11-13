import type { DecisionProvider } from "@totemora/core";
import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { ProjectRadarRepository } from "../repositories/project-radar-repository";
import { ProjectRadarDigestRepository } from "../repositories/project-radar-digest-repository";
import { parseProjectRadarSettings, projectRadarDay, projectRadarSettingsFingerprint } from "../domains/intelligence/project-radar-policy";
import { ProjectRadarEvaluator } from "./project-radar-evaluator";
import { ProjectRadarDigestService } from "./project-radar-digest-service";
import type { NotificationDispatchResult } from "./notification-dispatcher";
import { PROJECT_RADAR_RULE_MODEL } from "../domains/intelligence/project-radar-baseline";
import { ProjectRadarActionService } from "./project-radar-action-service";
import { ProjectRadarActionRepository } from "../repositories/project-radar-action-repository";

export class ProjectRadarConflictError extends Error {}
export class ProjectRadarInputError extends Error {}

export class ProjectRadarService {
  readonly repository: ProjectRadarRepository;
  readonly actions: ProjectRadarActionService;
  private readonly candidates: IntelligenceCandidateStore;
  private readonly runtime: ProjectRadarDigestRepository;
  private readonly evaluator: ProjectRadarEvaluator;
  private readonly digest: ProjectRadarDigestService;
  private readonly clock: () => Date;
  private readonly model: string;
  private evaluating = false;

  constructor(private readonly options: {
    dataDir: string;
    provider?: DecisionProvider;
    model?: string;
    dispatcher: { dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult> };
    authorizeEvaluation(): Promise<void>;
    authorizeDelivery(): Promise<void>;
    now?: () => Date;
    publicBaseUrl?: string;
  }) {
    this.clock = options.now ?? (() => new Date());
    this.model = options.provider ? options.model ?? "jev-latest" : PROJECT_RADAR_RULE_MODEL;
    this.repository = new ProjectRadarRepository(options.dataDir);
    this.actions = new ProjectRadarActionService({ repository: new ProjectRadarActionRepository(options.dataDir), now: this.clock });
    this.candidates = new IntelligenceCandidateStore(options.dataDir);
    this.runtime = new ProjectRadarDigestRepository(options.dataDir);
    this.evaluator = new ProjectRadarEvaluator({
      repository: this.repository, candidates: this.candidates, provider: options.provider,
      now: this.clock, model: this.model,
    });
    this.digest = new ProjectRadarDigestService({
      dataDir: options.dataDir, radarRepository: this.repository, dispatcher: options.dispatcher,
      authorize: options.authorizeDelivery, now: this.clock, model: this.model,
      actions: this.actions, publicBaseUrl: options.publicBaseUrl,
    });
  }

  async status() {
    const evaluations = await Promise.all(this.repository.listEvaluations(40).map(async (evaluation) => {
      const candidate = await this.candidates.get(evaluation.candidate_id);
      return { ...evaluation, headline: candidate?.headline ?? "候选已不可用", url: candidate?.url,
        brief: candidate?.brief, feedback: candidate?.feedback };
    }));
    return {
      settings: this.repository.getSettings(), configured: Boolean(this.options.provider),
      model: this.model, evaluations, baseline_available: true,
      evaluation_method: this.options.provider ? "jev" : "rules",
      usage: { ...this.repository.getUsage(projectRadarDay(this.clock())),
        rules_evaluations: this.repository.ruleUsage(projectRadarDay(this.clock())) },
      feedback: this.repository.feedbackCounts(), fallback_until: this.runtime.getFallbackUntil(),
    };
  }

  saveSettings(input: unknown) {
    let settings;
    try { settings = parseProjectRadarSettings(input, this.clock()); }
    catch (error) { throw new ProjectRadarInputError(error instanceof Error ? error.message : "Invalid radar settings"); }
    return this.repository.saveSettings(settings, this.clock());
  }

  async evaluate(input: { limit?: number; candidate_ids?: string[] } = {}) {
    if (this.repository.getSettings().mode === "off") throw new ProjectRadarConflictError("请先将项目雷达设置为观察或每日精选模式");
    if (this.evaluating) throw new ProjectRadarConflictError("项目雷达正在评估，请等待本次完成");
    this.evaluating = true;
    try {
      await this.options.authorizeEvaluation();
      const result = await this.evaluator.replay(input);
      const settings = this.repository.getSettings();
      for (const evaluation of result.evaluations) {
        if (evaluation.settings_fingerprint !== projectRadarSettingsFingerprint(settings, this.model)) continue;
        const candidate = await this.candidates.get(evaluation.candidate_id);
        if (candidate) this.actions.materialize({ evaluation, candidate,
          projects: settings.projects, evidence: this.repository.getEvidence(candidate) });
      }
      if (result.failed || result.budget_exhausted) this.fallback();
      // Keep the full fallback window: skipped or cached work cannot establish that
      // the external model recovered. The next hourly run can extend it on failure.
      return { ...result, evaluated: Math.max(0, result.evaluations.length - result.cached) };
    } catch (error) {
      this.fallback();
      throw error;
    } finally { this.evaluating = false; }
  }

  previewDigest() { return this.digest.preview(); }

  shouldDeferLegacyPush(): boolean {
    return this.repository.getSettings().mode === "active"
      && Date.parse(this.runtime.getFallbackUntil() ?? "1970-01-01") <= this.clock().getTime();
  }

  async runDue() {
    if (this.repository.getSettings().mode === "off") return undefined;
    const window = this.clock().toISOString().slice(0, 13);
    let evaluation;
    let evaluationError: string | undefined;
    if (!this.evaluating && this.runtime.claimEvaluationWindow(window)) {
      try { evaluation = await this.evaluate({ limit: 10 }); }
      catch { this.fallback(); evaluationError = "项目评估未完成，普通情报已回退到原有链路"; }
    }
    const digest = await this.digest.runDue();
    return { evaluation, digest, ...(evaluationError ? { evaluation_error: evaluationError } : {}) };
  }

  private fallback() {
    this.runtime.setFallbackUntil(new Date(this.clock().getTime() + 3_600_000).toISOString());
  }
}
