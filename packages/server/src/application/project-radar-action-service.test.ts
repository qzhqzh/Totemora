import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { StateDatabase } from "../state-database";
import { applyProjectRadarActionsMigration } from "../migrations/019-project-radar-actions";
import { ProjectRadarRepository } from "../repositories/project-radar-repository";
import { ProjectRadarActionRepository } from "../repositories/project-radar-action-repository";
import type { ProjectRadarEvaluation, ProjectRadarEvidence, ProjectRadarProject } from "../domains/intelligence/project-radar-types";
import { ProjectRadarActionService } from "./project-radar-action-service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const now = new Date("2026-10-25T10:00:00Z");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "radar-actions-")); directories.push(dir);
  const state = StateDatabase.open(dir); applyProjectRadarActionsMigration(state.db);
  const candidates = new IntelligenceCandidateStore(dir);
  const [candidate] = await candidates.ingest({ scan_id: "source-scan", member_id: "member", push_threshold: 0.7, history_hours: 24, now,
    evaluations: [{ event_key: "release", headline: "Generated claim not in original", brief: "Generated recommendation is not source evidence",
      url: "https://example.com/release", source: "official", importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9,
      push_worthy: true, rationale: "source", is_update: false }] });
  const project: ProjectRadarProject = { id: "echome", name: "EchoMe", goal: "评估记忆检索方法", focus: ["检索"], exclude: [], enabled: true };
  const evaluation: ProjectRadarEvaluation = { id: "evaluation-1", candidate_id: candidate.id,
    baseline: { scores: candidate.scores, status: candidate.status }, projects: [{ project_id: project.id, relevance: 0.9, confidence: 0.9 }],
    decision_confidence: 0.9, evidence_quality: 0.9, novelty: 0.9, urgency: 0.5, route: "digest", reason: "项目相关",
    model: "jev-test", question_version: "test", settings_fingerprint: "a".repeat(64), input_fingerprint: "b".repeat(64), created_at: now.toISOString() };
  const radar = new ProjectRadarRepository(dir); radar.saveEvaluation(evaluation);
  const evidence: ProjectRadarEvidence[] = [{ title: "检索方法的原始说明", url: candidate.url, text: "原文介绍检索方法和适用限制。", source: "official" }];
  const repository = new ProjectRadarActionRepository(dir);
  const service = new ProjectRadarActionService({ repository, now: () => now });
  return { dir, state, radar, repository, service, candidate, evaluation, project, evidence,
    input: { evaluation, candidate, projects: [project], evidence } };
}

test("action preserves original evidence and explicitly proposes verification without promoting generated facts", async () => {
  const f = await fixture(); const [action] = f.service.materialize(f.input);
  expect(action).toMatchObject({ candidate_id: f.candidate.id, evaluation_id: f.evaluation.id, project_id: "echome",
    project_name: "EchoMe", project_goal: "评估记忆检索方法", method: "jev", status: "proposed", decided_at: null, decision_source: null });
  expect(action.title).toContain(f.evidence[0].title);
  expect(action.next_step).toContain("建议核实");
  expect(action.acceptance_criteria.length).toBeGreaterThan(1);
  expect(action.evidence[0]).toMatchObject({ url: f.candidate.url, excerpt: f.evidence[0].text });
  expect(JSON.stringify(action)).not.toContain(f.candidate.headline);
  expect(JSON.stringify(action)).not.toContain(f.candidate.brief);
  expect(new ProjectRadarActionService({ repository: new ProjectRadarActionRepository(f.dir) }).list()).toEqual([action]);
  expect(f.service.materialize(f.input)).toEqual([action]);
});

test("rule scores produce explicitly labelled suggestions without pretending to be model confidence", async () => {
  const f = await fixture();
  const evaluation = { ...f.evaluation, evaluation_method: "rules" as const, decision_confidence: null,
    projects: [{ project_id: "echome", relevance: 0.8, confidence: null, matched_terms: ["检索"] }] };
  const [action] = f.service.materialize({ ...f.input, evaluation });
  expect(action.method).toBe("rules"); expect(action.rationale).toContain("规则匹配");
  expect(action.rationale).toContain("不代表模型信心");
});

test("generation requires a linked evaluation, an enabled relevant card, original evidence and original fact gates", async () => {
  const f = await fixture();
  expect(() => f.service.materialize({ ...f.input, evaluation: { ...f.evaluation, candidate_id: "other" } })).toThrow("candidate");
  for (const route of ["hold", "review"] as const) expect(f.service.materialize({ ...f.input, evaluation: { ...f.evaluation, route } })).toEqual([]);
  expect(f.service.materialize({ ...f.input, projects: [] })).toEqual([]);
  expect(f.service.materialize({ ...f.input, projects: [{ ...f.project, enabled: false }] })).toEqual([]);
  expect(f.service.materialize({ ...f.input, projects: [{ ...f.project, id: "other" }] })).toEqual([]);
  expect(f.service.materialize({ ...f.input, evidence: [] })).toEqual([]);
  expect(f.service.materialize({ ...f.input, evidence: [{ ...f.evidence[0], url: "https://example.com/other" }] })).toEqual([]);
  expect(f.service.materialize({ ...f.input, evidence: [{ ...f.evidence[0], text: " " }] })).toEqual([]);
  for (const url of ["http://example.com/a", "https://user:password@example.com/a", "javascript:alert(1)"]) {
    expect(f.service.materialize({ ...f.input, candidate: { ...f.candidate, url }, evidence: [{ ...f.evidence[0], url }] })).toEqual([]);
  }
  for (const candidate of [{ ...f.candidate, duplicate_of: "prior" }, { ...f.candidate, status: "held" as const },
    { ...f.candidate, scores: { ...f.candidate.scores, confidence: 0.54 } }, { ...f.candidate, domain: "finance" as const, evidence_tier: "S4" as const }]) {
    expect(f.service.materialize({ ...f.input, candidate })).toEqual([]);
  }
  for (const patch of [{ novelty: 0.3 }, { evidence_quality: 0.5 }, { decision_confidence: 0.5 },
    { projects: [{ project_id: "echome", relevance: 0.2, confidence: 0.9 }] }]) {
    expect(f.service.materialize({ ...f.input, evaluation: { ...f.evaluation, ...patch } })).toEqual([]);
  }
  expect(f.service.list()).toEqual([]);
});

test("acceptance is durable and idempotent, while opposite decisions and reused keys with a changed body conflict", async () => {
  const f = await fixture(); const [action] = f.service.materialize(f.input);
  const input = { decision: "accept", idempotency_key: "request-1", source: "web" };
  const accepted = f.service.decide(action.id, input);
  expect(accepted).toMatchObject({ status: "accepted", decision_source: "web", decided_at: now.toISOString() });
  const restarted = new ProjectRadarActionService({ repository: new ProjectRadarActionRepository(f.dir), now: () => new Date("2026-10-26") });
  expect(restarted.decide(action.id, input)).toEqual(accepted);
  expect(restarted.decide(action.id, { ...input, idempotency_key: "request-2", source: "telegram" })).toEqual(accepted);
  expect(() => restarted.decide(action.id, { ...input, source: "telegram" })).toThrow("idempotency");
  expect(() => restarted.decide(action.id, { ...input, decision: "dismiss" })).toThrow("idempotency");
  expect(() => restarted.decide(action.id, { decision: "dismiss", idempotency_key: "request-3" })).toThrow("decided");
  expect(restarted.list()).toEqual([accepted]);
});

test("decided actions retain the evidence and recommendation approved by the operator", async () => {
  const f = await fixture(); const [action] = f.service.materialize(f.input);
  const dismissed = f.service.decide(action.id, { decision: "dismiss", idempotency_key: "dismiss-1", source: "telegram" });
  const newer = { ...f.evaluation, id: "evaluation-2", input_fingerprint: "c".repeat(64) }; f.radar.saveEvaluation(newer);
  expect(f.service.materialize({ ...f.input, evaluation: newer, projects: [{ ...f.project, name: "changed" }],
    evidence: [{ ...f.evidence[0], text: "changed" }] })).toEqual([dismissed]);
  expect(f.service.list()).toEqual([dismissed]);
});

test("handoff requires acceptance and returns an unsubmitted draft without inventing Lifeline IDs", async () => {
  const f = await fixture(); const [action] = f.service.materialize(f.input);
  expect(() => f.service.handoff(action.id)).toThrow("accepted");
  expect(() => f.service.handoff("missing")).toThrow("not found");
  f.service.decide(action.id, { decision: "accept", idempotency_key: "accept" });
  const draft = f.service.handoff(action.id);
  expect(draft).toMatchObject({ destination: "lifeline", status: "draft", submitted: false, ready: false,
    project_id: null, phase_id: null, missing_fields: ["project_id", "phase_id"],
    source: { action_id: action.id, candidate_id: f.candidate.id, evaluation_id: f.evaluation.id, radar_project_id: "echome" } });
  expect(draft.evidence).toEqual(action.evidence);
  const mapped = new ProjectRadarActionService({ repository: f.repository,
    lifelineTargets: { echome: { project_id: "known-project-id", phase_id: "known-phase-id" } } });
  expect(mapped.handoff(action.id)).toMatchObject({ status: "draft", submitted: false, ready: true,
    project_id: "known-project-id", phase_id: "known-phase-id", missing_fields: [] });
});

test("decision DTO rejects unknown fields, control characters, unbounded keys and invalid source", async () => {
  const f = await fixture(); const [action] = f.service.materialize(f.input);
  for (const value of [null, {}, { decision: "execute", idempotency_key: "key" }, { decision: "accept", idempotency_key: "" },
    { decision: "accept", idempotency_key: "a".repeat(129) }, { decision: "accept", idempotency_key: "a\nb" },
    { decision: "accept", idempotency_key: "key", source: "cron" }, { decision: "accept", idempotency_key: "key", source: null }, { decision: "accept", idempotency_key: "key", execute: true }]) {
    expect(() => f.service.decide(action.id, value)).toThrow();
  }
  expect(() => f.service.decide("missing", { decision: "accept", idempotency_key: "key" })).toThrow("not found");
  expect(f.service.list()[0].status).toBe("proposed");
});


test("raw evidence is bounded and cleaned without inventing a publication time", async () => {
  const f = await fixture();
  expect(f.service.materialize({ ...f.input, evidence: [{ ...f.evidence[0], text: "\u0000\u007f" }] })).toEqual([]);
  const [action] = f.service.materialize({ ...f.input, evidence: [{ ...f.evidence[0], title: "Original\nTitle",
    text: `First\n${"details ".repeat(1_000)}`, published_at: "2026-10-25" }] });
  expect(action.evidence[0].title).toBe("Original Title");
  expect(action.evidence[0].excerpt.length).toBeLessThanOrEqual(2_000);
  expect(action.evidence[0].excerpt).not.toContain("\n");
  expect(action.evidence[0].published_at).toBe("2026-10-25");
});
