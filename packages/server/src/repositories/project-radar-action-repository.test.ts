import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../state-database";
import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { applyProjectRadarActionsMigration } from "../migrations/019-project-radar-actions";
import { ProjectRadarRepository } from "./project-radar-repository";
import { ProjectRadarActionRepository } from "./project-radar-action-repository";
import type { ProjectRadarAction } from "../domains/intelligence/project-radar-action";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const now = new Date("2026-10-25T10:00:00Z");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "radar-action-repo-")); directories.push(dir);
  const state = StateDatabase.open(dir); applyProjectRadarActionsMigration(state.db);
  const [candidate] = await new IntelligenceCandidateStore(dir).ingest({ scan_id: "scan", member_id: "member", push_threshold: 0.7, history_hours: 24, now,
    evaluations: [{ event_key: "release", headline: "Release", brief: "Summary", url: "https://example.com/release", source: "official",
      importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9, push_worthy: true, rationale: "source", is_update: false }] });
  new ProjectRadarRepository(dir).saveEvaluation({ id: "evaluation", candidate_id: candidate.id,
    baseline: { scores: candidate.scores, status: candidate.status }, projects: [{ project_id: "echome", relevance: 0.9, confidence: 0.9 }],
    decision_confidence: 0.9, evidence_quality: 0.9, novelty: 0.9, urgency: 0.5, route: "digest", reason: "relevant", model: "jev-test",
    question_version: "test", settings_fingerprint: "a".repeat(64), input_fingerprint: "b".repeat(64), created_at: now.toISOString() });
  const proposal: ProjectRadarAction = { id: crypto.randomUUID(), candidate_id: candidate.id, evaluation_id: "evaluation", project_id: "echome",
    project_name: "EchoMe", project_goal: "记忆检索", title: "核实适用性", rationale: "项目相关", next_step: "建议核实原文", acceptance_criteria: ["记录原文和结论"],
    evidence: [{ title: "Release", url: candidate.url, source: "official", excerpt: "Original evidence" }], method: "rules",
    status: "proposed", created_at: now.toISOString(), decided_at: null, decision_source: null };
  const repository = new ProjectRadarActionRepository(dir);
  return { dir, state, repository, proposal, action: repository.saveProposal(proposal) };
}

test("two repository callers share one immutable decision and one idempotent receipt", async () => {
  const f = await fixture(); const second = new ProjectRadarActionRepository(f.dir);
  const decision = { decision: "accept", idempotency_key: "same-request", source: "telegram" };
  const results = await Promise.all([f.repository, second].map(async (repo) => repo.decide(f.action.id, decision, now)));
  expect(results[0]).toEqual(results[1]);
  expect(f.state.db.query("SELECT COUNT(*) count FROM project_radar_action_decisions").get()).toEqual({ count: 1 });
  const competing = await Promise.allSettled([f.repository, second].map(async (repo, index) => repo.decide(f.action.id,
    { decision: index ? "dismiss" : "accept", idempotency_key: `competing-${index}`, source: "web" }, now)));
  expect(competing.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(second.get(f.action.id)).toEqual(results[0]);
});

test("idempotency keys cannot be reused for another action", async () => {
  const f = await fixture(); const other = f.repository.saveProposal({ ...f.proposal, id: crypto.randomUUID(), project_id: "totemora" });
  const request = { decision: "accept", idempotency_key: "global-request" };
  f.repository.decide(f.action.id, request, now);
  expect(() => f.repository.decide(other.id, request, now)).toThrow("idempotency");
  expect(f.repository.get(other.id)?.status).toBe("proposed");
});

test("receipt insertion failure rolls the decision back and permits a clean retry", async () => {
  const f = await fixture();
  f.state.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON project_radar_action_decisions BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
  const request = { decision: "accept", idempotency_key: "rollback-request" };
  expect(() => f.repository.decide(f.action.id, request, now)).toThrow("fixture receipt failure");
  expect(f.repository.get(f.action.id)).toEqual(f.action);
  expect(f.state.db.query("SELECT COUNT(*) count FROM project_radar_action_decisions").get()).toEqual({ count: 0 });
  f.state.db.exec("DROP TRIGGER fail_receipt");
  expect(f.repository.decide(f.action.id, request, now).status).toBe("accepted");
});

test("proposal identity and first evidence are stable across multiple materializers", async () => {
  const f = await fixture(); const second = new ProjectRadarActionRepository(f.dir);
  const replay = second.saveProposal({ ...f.proposal, id: crypto.randomUUID(), title: "A newer draft" });
  expect(replay).toEqual(f.action); expect(second.list()).toEqual([f.action]);
  expect(() => second.saveProposal({ ...f.proposal, status: "accepted", decided_at: now.toISOString(), decision_source: "web" })).toThrow("proposed");
  for (const value of [0, 501, 1.5, NaN, Infinity]) expect(() => second.list(value)).toThrow("limit");
  expect(second.list(1)).toEqual([f.action]);
});
