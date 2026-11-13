import { IntelligenceCandidateStore, type IntelligenceCandidate } from "../intelligence-candidate-store";
import { projectRadarDay, projectRadarSettingsFingerprint } from "../domains/intelligence/project-radar-policy";
import type { ProjectRadarEvaluation, ProjectRadarSettings } from "../domains/intelligence/project-radar-types";
import { parseNotificationEnvelope } from "../domains/notification/notification-envelope";
import type { ProjectRadarRepository } from "../repositories/project-radar-repository";
import { ProjectRadarDigestRepository, type ProjectRadarDigestItem, type ProjectRadarDigestRecord,
  type ProjectRadarDigestSnapshot, type ProjectRadarDigestStatus } from "../repositories/project-radar-digest-repository";
import type { NotificationDispatchResult } from "./notification-dispatcher";
import type { ProjectRadarActionService } from "./project-radar-action-service";

export interface ProjectRadarDigestPreview {
  date: string;
  title: string;
  body: string;
  items: ProjectRadarDigestItem[];
  status: "preview" | ProjectRadarDigestStatus;
}
export interface ProjectRadarDigestServiceOptions {
  dataDir: string;
  radarRepository: ProjectRadarRepository;
  dispatcher: { dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult> };
  authorize: () => Promise<void>;
  now?: () => Date;
  model?: string;
  actions?: Pick<ProjectRadarActionService, "list">;
  publicBaseUrl?: string;
}

export class ProjectRadarDigestService {
  private readonly digests: ProjectRadarDigestRepository;
  private readonly candidates: IntelligenceCandidateStore;
  constructor(private readonly options: ProjectRadarDigestServiceOptions) {
    this.digests = new ProjectRadarDigestRepository(options.dataDir);
    this.candidates = new IntelligenceCandidateStore(options.dataDir);
  }
  async preview(): Promise<ProjectRadarDigestPreview> {
    const now = this.options.now?.() ?? new Date();
    const stored = this.digests.get(projectRadarDay(now));
    return stored ? publicView(stored) : publicView(await this.build(this.options.radarRepository.getSettings(), now));
  }
  async runDue(): Promise<ProjectRadarDigestPreview | undefined> {
    const now = this.options.now?.() ?? new Date();
    this.digests.recoverStale(now);
    const settings = this.options.radarRepository.getSettings();
    if (settings.mode !== "active" || !isDue(settings, now)) return undefined;
    const existing = this.digests.get(projectRadarDay(now));
    if (existing && (existing.status !== "failed" || existing.attempts >= 3 || !existing.retry_after
      || existing.retry_after > now.toISOString())) return publicView(existing);
    const snapshot = existing ?? await this.build(settings, now);
    if (snapshot.settings_fingerprint !== projectRadarSettingsFingerprint(settings, this.options.model)
      || snapshot.settings_updated_at !== settings.updated_at) return existing ? publicView(existing) : undefined;
    // Authorization happens before the durable external-effect claim on every attempt.
    if (snapshot.items.length) await this.options.authorize();
    const claimTime = this.options.now?.() ?? now;
    if (!isDue(settings, claimTime)) return undefined;
    const claimed = this.digests.claim(snapshot, claimTime);
    if (!claimed) return undefined;
    if (claimed.status === "empty") return publicView(claimed);
    let outcome: "completed" | "failed" | "uncertain";
    try {
      const result = await this.options.dispatcher.dispatch({ envelope: claimed.envelope, member_id: "qwen_intelligence" });
      outcome = dispatchOutcome(result);
    } catch {
      // A rejected dispatch promise cannot establish whether any target accepted delivery.
      outcome = "uncertain";
    }
    this.digests.finish(claimed.date, claimed.lease_token!, outcome, this.options.now?.() ?? now);
    return publicView(this.digests.get(claimed.date)!);
  }
  private async build(settings: ProjectRadarSettings, now: Date): Promise<ProjectRadarDigestSnapshot> {
    const fingerprint = projectRadarSettingsFingerprint(settings, this.options.model);
    const candidates = new Map((await this.candidates.list(1_000, "ai")).map((item) => [item.id, item]));
    const evaluations = this.options.radarRepository.listEvaluations(500);
    const latest = new Map<string, ProjectRadarEvaluation>();
    for (const evaluation of evaluations) if (!latest.has(evaluation.candidate_id)) latest.set(evaluation.candidate_id, evaluation);
    const settingsUpdatedAt = Date.parse(settings.updated_at);
    const selected: { candidate: IntelligenceCandidate; evaluation: ProjectRadarEvaluation; names: string[] }[] = [];
    for (const evaluation of latest.values()) {
      const candidate = candidates.get(evaluation.candidate_id);
      if (!candidate || !eligible(candidate, evaluation, fingerprint, settingsUpdatedAt, now)
        || this.digests.isClaimed(candidate.id)) continue;
      if (this.digests.hasPriorDelivery(candidate) && (!candidate.is_update || evaluation.novelty < 0.75)) continue;
      const names = evaluation.projects.filter((project) => project.relevance >= 0.65
        && (evaluation.evaluation_method === "rules" ? Boolean(project.matched_terms?.length) : (project.confidence ?? 0) >= 0.65))
        .flatMap((project) => settings.projects.filter((card) => card.enabled && card.id === project.project_id).map((card) => card.name));
      if (names.length) selected.push({ candidate, evaluation, names });
    }
    selected.sort((a, b) => Number(b.evaluation.route === "immediate") - Number(a.evaluation.route === "immediate")
      || b.candidate.scores.total - a.candidate.scores.total || b.candidate.created_at.localeCompare(a.candidate.created_at));
    const items: ProjectRadarDigestItem[] = [];
    const blocks: string[] = [];
    const events = new Set<string>();
    const urls = new Set<string>();
    let bytes = 0;
    const actions = this.options.actions?.list(500) ?? [];
    for (const { candidate, evaluation, names } of selected) {
      if (items.length >= settings.digest_limit) break;
      if (events.has(candidate.event_key) || urls.has(candidate.url)) continue;
      const action = actions.find((item) => item.candidate_id === candidate.id && item.evaluation_id === evaluation.id && item.status !== "dismissed");
      const rendered = renderItem(candidate, evaluation, names, items.length + 1, 3_200 - bytes - (items.length ? 2 : 0), action);
      if (!rendered) continue;
      items.push(rendered.item); blocks.push(rendered.body);
      bytes += Buffer.byteLength(rendered.body) + (items.length > 1 ? 2 : 0);
      events.add(candidate.event_key); urls.add(candidate.url);
    }
    const date = projectRadarDay(now);
    const title = `项目每日精选 · ${date}`;
    const body = blocks.join("\n\n");
    const envelope = items.length ? parseNotificationEnvelope({ schema_version: 1, id: `project-radar:${date}`,
      idempotency_key: `project-radar:${date}`, domain: "ai", kind: "digest", title, body, priority: 3,
      tags: ["project-radar"], click_url: this.options.publicBaseUrl && safeUrl(this.options.publicBaseUrl)
        ? new URL("/#project-radar-panel", this.options.publicBaseUrl).toString() : items[0].url }) : undefined;
    return { date, title, body, items, settings_fingerprint: fingerprint, settings_updated_at: settings.updated_at,
      ...(envelope ? { envelope } : {}) };
  }
}

function publicView(value: ProjectRadarDigestSnapshot | ProjectRadarDigestRecord): ProjectRadarDigestPreview {
  return { date: value.date, title: value.title, body: value.body, items: value.items, status: "status" in value ? value.status : "preview" };
}
function isDue(settings: ProjectRadarSettings, now: Date): boolean {
  const scheduled = Date.parse(`${projectRadarDay(now)}T${settings.digest_time}:00+08:00`);
  return now.getTime() >= scheduled && now.getTime() < scheduled + 60 * 60_000;
}
function eligible(candidate: IntelligenceCandidate, evaluation: ProjectRadarEvaluation, fingerprint: string, settingsUpdatedAt: number, now: Date): boolean {
  const allowed = ["queued", "retry_wait", "channel_blocked"];
  return allowed.includes(candidate.status) && allowed.includes(evaluation.baseline.status)
    && !candidate.pushed_at && !candidate.duplicate_of && !candidate.claim_token && safeUrl(candidate.url)
    && (!candidate.next_attempt_at || Date.parse(candidate.next_attempt_at) <= now.getTime())
    && Date.parse(candidate.created_at) >= now.getTime() - 86_400_000 && Date.parse(candidate.created_at) <= now.getTime()
    && Date.parse(evaluation.created_at) >= settingsUpdatedAt && Date.parse(evaluation.created_at) <= now.getTime()
    && evaluation.settings_fingerprint === fingerprint && ["digest", "immediate"].includes(evaluation.route)
    && candidate.scores.confidence >= 0.55 && evaluation.baseline.scores.confidence >= 0.55
    && (evaluation.evaluation_method === "rules" ? evaluation.projects.some((project) => Boolean(project.matched_terms?.length))
      : (evaluation.decision_confidence ?? 0) >= 0.65)
    && evaluation.evidence_quality >= 0.6 && evaluation.novelty >= 0.55;
}
function safeUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password
    && value.length <= 2_048 && !/[\s\x00-\x1f\x7f]/.test(value); } catch { return false; }
}
function renderItem(candidate: IntelligenceCandidate, evaluation: ProjectRadarEvaluation, names: string[], index: number, available: number,
  action?: { id: string; next_step: string }): { item: ProjectRadarDigestItem; body: string } | undefined {
  const urlBytes = Buffer.byteLength(candidate.url);
  const budget = Math.min(available, Math.max(action ? 950 : 620, urlBytes + 330));
  if (budget < urlBytes + 120) return undefined;
  const actionStep = action ? truncate(action.next_step, 210) : undefined;
  const textBudget = budget - urlBytes - 80 - (actionStep ? Buffer.byteLength(actionStep) + 20 : 0);
  const item: ProjectRadarDigestItem = { candidate_id: candidate.id, evaluation_id: evaluation.id, url: candidate.url,
    headline: truncate(candidate.headline, Math.floor(textBudget * 0.25)), brief: truncate(candidate.brief, Math.floor(textBudget * 0.4)),
    project_names: names.slice(0, 2).map((name) => truncate(name, Math.floor(textBudget * 0.15 / Math.min(names.length, 2)))),
    reason: truncate(evaluation.reason, Math.floor(textBudget * 0.2)),
    ...(action ? { action_id: action.id, next_step: actionStep } : {}) };
  const body = `${index}. ${item.headline}\n${item.brief}\n项目：${item.project_names.join(" / ")}\n入选理由：${item.reason}${actionStep ? `\n建议：${actionStep}` : ""}\n${item.url}`;
  return Buffer.byteLength(body) <= available ? { item, body } : undefined;
}
function truncate(value: string, bytes: number): string {
  const clean = value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (Buffer.byteLength(clean) <= bytes) return clean;
  let result = "";
  let size = 3;
  for (const char of clean) { const next = Buffer.byteLength(char); if (size + next > bytes) break; result += char; size += next; }
  return `${result}…`;
}
function dispatchOutcome(result: NotificationDispatchResult): "completed" | "failed" | "uncertain" {
  if (result.status === "uncertain" || result.deliveries.some((delivery) => delivery.status === "uncertain")) return "uncertain";
  if (result.status === "completed") return result.deliveries.length > 0 && result.deliveries.every((delivery) => delivery.status === "completed") ? "completed" : "uncertain";
  return ["failed", "partial", "unconfigured"].includes(result.status) ? "failed" : "uncertain";
}
