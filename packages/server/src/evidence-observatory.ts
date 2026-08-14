import type { LocalConfigSet } from "@totemora/core";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { IntelligenceBrief } from "./intelligence-service";
import { MemberStateStore } from "./member-state-store";
import { StateDatabase } from "./state-database";

export interface CandidateFunnel {
  domain: "ai" | "finance";
  scans: number;
  sources_collected: number;
  sources_out_of_scope: number;
  sources_history_suppressed: number;
  sources_sent_to_model: number;
  model_calls_avoided: number;
  candidates_evaluated: number;
  candidates_held: number;
  candidates_queued: number;
  candidates_pushed: number;
  candidates_failed: number;
  candidates_delivery_unknown: number;
  duplicate_candidates: number;
  valuable_candidates: number;
  opened_candidates: number;
  duplicate_rate: number | null;
  delivery_success_rate: number | null;
  explicit_value_rate: number | null;
}

export interface MemberOutcomeEvidence {
  member_id: string;
  name: string;
  operations: number;
  judged_outcomes: number;
  accepted_outcomes: number;
  member_failures: number;
  system_failures: number;
  experience_credit: number;
  acceptance_rate: number;
}

export interface ServiceTaskEvidence {
  service_id: string;
  total: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  completion_rate: number;
}

export interface EvidenceOverview {
  generated_at: string;
  candidate_funnels: CandidateFunnel[];
  member_outcomes: MemberOutcomeEvidence[];
  service_tasks: ServiceTaskEvidence[];
  external_actions: Record<string, number>;
  recent_benchmarks: BenchmarkEvidenceSummary[];
  notices: Array<{ level: "attention" | "info"; code: string; title: string; detail: string }>;
}

export interface BenchmarkEvidenceSummary {
  id: string;
  suite_id: string;
  suite_version: number;
  task_count: number;
  created_at: string;
  pricing_status: "configured" | "partial" | "unconfigured";
  strategies: Array<{
    id: string;
    attempted: number;
    structural_pass_rate: number;
    total_tokens: number;
    strong_model_tokens: number;
    known_cost_usd: number;
    pricing_gap_cases: number;
  }>;
}

interface CandidateAggregateRow {
  domain: "ai" | "finance";
  evaluated: number;
  held: number;
  queued: number;
  pushed: number;
  failed: number;
  delivery_unknown: number;
  duplicates: number;
}

interface FeedbackAggregateRow {
  domain: "ai" | "finance";
  valuable: number;
  opened: number;
}

interface ServiceAggregateRow {
  service_id: string;
  total: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export class EvidenceObservatory {
  private readonly state: StateDatabase;
  private readonly members: MemberStateStore;

  constructor(dataDir: string, config: LocalConfigSet) {
    this.state = StateDatabase.open(dataDir);
    this.members = new MemberStateStore(dataDir, config);
  }

  async overview(): Promise<EvidenceOverview> {
    const candidateRows = this.state.db.query(`
      SELECT domain,
        COUNT(*) evaluated,
        SUM(CASE WHEN status='held' THEN 1 ELSE 0 END) held,
        SUM(CASE WHEN status IN ('queued','pushing','retry_wait','channel_blocked') THEN 1 ELSE 0 END) queued,
        SUM(CASE WHEN status='pushed' THEN 1 ELSE 0 END) pushed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='delivery_unknown' THEN 1 ELSE 0 END) delivery_unknown,
        SUM(CASE WHEN duplicate_of IS NOT NULL THEN 1 ELSE 0 END) duplicates
      FROM intelligence_candidates GROUP BY domain
    `).all() as CandidateAggregateRow[];
    const feedbackRows = this.state.db.query(`
      SELECT c.domain,
        COUNT(DISTINCT CASE WHEN f.signal='valuable' THEN c.id END) valuable,
        COUNT(DISTINCT CASE WHEN f.signal='opened' THEN c.id END) opened
      FROM candidate_feedback f
      JOIN intelligence_candidates c ON c.id=f.candidate_id
      GROUP BY c.domain
    `).all() as FeedbackAggregateRow[];
    const candidateFunnels = (["ai", "finance"] as const).map((domain) => this.candidateFunnel(
      domain,
      candidateRows.find((row) => row.domain === domain),
      feedbackRows.find((row) => row.domain === domain),
    ));

    const dossiers = await this.members.listDossiers();
    const memberOutcomes = dossiers.map((dossier): MemberOutcomeEvidence => ({
      member_id: dossier.member.id,
      name: dossier.member.name ?? dossier.member.id,
      operations: dossier.growth.operation_count,
      judged_outcomes: dossier.portrait.task_record.completed,
      accepted_outcomes: dossier.portrait.task_record.accepted,
      member_failures: dossier.portrait.task_record.member_failures,
      system_failures: dossier.portrait.task_record.system_failures,
      experience_credit: dossier.portrait.task_record.experience_credit,
      acceptance_rate: dossier.portrait.task_record.success_rate,
    })).filter((member) => member.operations || member.judged_outcomes || member.system_failures);

    const serviceRows = this.state.db.query(`
      SELECT service_id,
        COUNT(*) total,
        SUM(CASE WHEN status IN ('queued','routing','running','waiting_approval','waiting_external') THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled
      FROM specialist_tasks GROUP BY service_id ORDER BY service_id
    `).all() as ServiceAggregateRow[];
    const serviceTasks = serviceRows.map((row): ServiceTaskEvidence => ({
      ...row,
      completion_rate: ratio(row.completed, row.completed + row.failed + row.cancelled) ?? 0,
    }));
    const externalActions = Object.fromEntries((this.state.db.query(`
      SELECT status,COUNT(*) count FROM action_journal GROUP BY status ORDER BY status
    `).all() as Array<{ status: string; count: number }>).map((row) => [row.status, row.count]));

    return {
      generated_at: new Date().toISOString(),
      candidate_funnels: candidateFunnels,
      member_outcomes: memberOutcomes,
      service_tasks: serviceTasks,
      external_actions: externalActions,
      recent_benchmarks: await this.recentBenchmarks(),
      notices: buildNotices(candidateFunnels, memberOutcomes),
    };
  }

  private async recentBenchmarks(): Promise<BenchmarkEvidenceSummary[]> {
    const directory = resolve(this.state.path, "..", "benchmarks");
    let names: string[];
    try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); }
    catch { return []; }
    const ranked = (await Promise.all(names.map(async (name) => {
      const path = resolve(directory, name);
      try { return { name, mtime: (await stat(path)).mtimeMs }; }
      catch { return undefined; }
    }))).filter((item): item is { name: string; mtime: number } => Boolean(item))
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, 50);
    const results: BenchmarkEvidenceSummary[] = [];
    for (const { name } of ranked) {
      const path = resolve(directory, name);
      try {
        if ((await stat(path)).size > 2_000_000) continue;
        const value = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
        if (value.schema_version !== 1 || !value.id || !value.suite || !value.summary) continue;
        const strategies = Object.entries(value.summary as Record<string, Record<string, unknown>>).map(([id, summary]) => ({
          id,
          attempted: finite(summary.attempted),
          structural_pass_rate: finite(summary.structural_pass_rate),
          total_tokens: finite(summary.total_tokens),
          strong_model_tokens: finite(summary.strong_model_tokens),
          known_cost_usd: finite(summary.known_cost_usd),
          pricing_gap_cases: finite(summary.pricing_gap_cases),
        }));
        results.push({
          id: String(value.id), suite_id: String(value.suite.id),
          suite_version: finite(value.suite.version), task_count: finite(value.suite.task_count),
          created_at: String(value.created_at),
          pricing_status: ["configured", "partial"].includes(value.pricing_status) ? value.pricing_status : "unconfigured",
          strategies,
        });
      } catch { /* A partial or legacy artifact is not public evidence. */ }
    }
    return results
      .filter((item) => Number.isFinite(Date.parse(item.created_at)))
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 5);
  }

  private candidateFunnel(
    domain: "ai" | "finance",
    aggregate?: CandidateAggregateRow,
    feedback?: FeedbackAggregateRow,
  ): CandidateFunnel {
    const namespace = domain === "ai" ? "intelligence_briefs" : "finance_intelligence_briefs";
    const briefs = this.state.listRecords<IntelligenceBrief>(namespace);
    const sourceGate = briefs.reduce((total, brief) => ({
      collected: total.collected + (brief.source_gate?.collected ?? 0),
      out_of_scope: total.out_of_scope + (brief.source_gate?.out_of_scope ?? 0),
      history_suppressed: total.history_suppressed + (brief.source_gate?.history_suppressed ?? 0),
      model_evaluated: total.model_evaluated + (brief.source_gate?.model_evaluated ?? 0),
      avoided: total.avoided + (brief.source_gate && brief.source_gate.model_evaluated === 0
        && brief.source_gate.history_suppressed > 0 ? 1 : 0),
    }), { collected: 0, out_of_scope: 0, history_suppressed: 0, model_evaluated: 0, avoided: 0 });
    const evaluated = aggregate?.evaluated ?? 0;
    const pushed = aggregate?.pushed ?? 0;
    const failed = aggregate?.failed ?? 0;
    const deliveryUnknown = aggregate?.delivery_unknown ?? 0;
    return {
      domain,
      scans: briefs.length,
      sources_collected: sourceGate.collected,
      sources_out_of_scope: sourceGate.out_of_scope,
      sources_history_suppressed: sourceGate.history_suppressed,
      sources_sent_to_model: sourceGate.model_evaluated,
      model_calls_avoided: sourceGate.avoided,
      candidates_evaluated: evaluated,
      candidates_held: aggregate?.held ?? 0,
      candidates_queued: aggregate?.queued ?? 0,
      candidates_pushed: pushed,
      candidates_failed: failed,
      candidates_delivery_unknown: deliveryUnknown,
      duplicate_candidates: aggregate?.duplicates ?? 0,
      valuable_candidates: feedback?.valuable ?? 0,
      opened_candidates: feedback?.opened ?? 0,
      duplicate_rate: ratio(aggregate?.duplicates ?? 0, evaluated),
      delivery_success_rate: ratio(pushed, pushed + failed + deliveryUnknown),
      explicit_value_rate: ratio(feedback?.valuable ?? 0, pushed),
    };
  }
}

function buildNotices(
  funnels: CandidateFunnel[],
  members: MemberOutcomeEvidence[],
): EvidenceOverview["notices"] {
  const notices: EvidenceOverview["notices"] = [];
  for (const funnel of funnels) {
    if (funnel.candidates_evaluated >= 20 && (funnel.duplicate_rate ?? 0) >= 0.25) notices.push({
      level: "attention", code: `${funnel.domain}:duplicate_pressure`,
      title: `${funnel.domain === "ai" ? "AI" : "财经"}候选重复压力偏高`,
      detail: `${percent(funnel.duplicate_rate ?? 0)} 的候选在模型评估后才被识别为重复；应继续把聚类前移。`,
    });
    if (funnel.candidates_failed + funnel.candidates_delivery_unknown > 0) notices.push({
      level: "attention", code: `${funnel.domain}:delivery_failures`,
      title: `${funnel.domain === "ai" ? "AI" : "财经"}外发存在未闭环记录`,
      detail: `${funnel.candidates_failed} 条失败，${funnel.candidates_delivery_unknown} 条状态不确定。`,
    });
  }
  const noisy = members.filter((member) => member.system_failures >= 5)
    .sort((left, right) => right.system_failures - left.system_failures)[0];
  if (noisy) notices.push({
    level: "info", code: "member:system_noise",
    title: `${noisy.name} 遭遇较多系统噪声`,
    detail: `${noisy.system_failures} 次系统故障已与成员失败隔离，不会降低其验收成功率。`,
  });
  return notices;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? Number((numerator / denominator).toFixed(3)) : null;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
