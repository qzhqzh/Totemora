import { expect, test } from "bun:test";
import type { DecisionProvider, DecisionRequest, DecisionResponse } from "@totemora/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { StateDatabase } from "../state-database";
import { ProjectRadarRepository } from "../repositories/project-radar-repository";
import { projectRadarSettingsFingerprint } from "../domains/intelligence/project-radar-policy";
import { ProjectRadarEvaluator } from "./project-radar-evaluator";

const now = new Date("2026-09-22T10:00:00Z");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "radar-evaluator-"));
  const candidates = new IntelligenceCandidateStore(dir);
  const [candidate] = await candidates.ingest({ scan_id: "scan", member_id: "member", push_threshold: 0.7, history_hours: 72, now,
    evaluations: [{ event_key: "release", headline: "Agent release", brief: "Model-generated claim", url: "https://example.com/release", source: "official",
      importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9, push_worthy: true, rationale: "test", is_update: false }] });
  const repository = new ProjectRadarRepository(dir);
  const state = StateDatabase.open(dir);
  const evidence = (text = "Original release notes: typed decisions added") => state.putRecord("intelligence_briefs", "scan", {
    sources: [{ title: "Official release", link: candidate!.url, source: "official", summary: text }],
  });
  evidence();
  return { dir, candidates, candidate: candidate!, repository, state, evidence };
}
function response(request: DecisionRequest, confidence = 0.9): DecisionResponse {
  return { model: "jev-test", usage: { inputTokens: 100 }, answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, {
    type: "score", score: key === "urgency" ? 2 : 4, confidence,
    legend: {}, probabilities: {},
  }])) };
}

test("off performs no calls; shadow uses source evidence and caches stable inputs", async () => {
  const fixtureData = await fixture();
  const { dir, repository, candidates, candidate } = fixtureData;
  const calls: DecisionRequest[] = [];
  const provider: DecisionProvider = { evaluate: async (request) => { calls.push(request); return response(request); } };
  const evaluator = new ProjectRadarEvaluator({ repository, candidates, provider, now: () => now });
  try {
    expect((await evaluator.replay()).evaluations).toEqual([]);
    expect(calls).toHaveLength(0);
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow" });
    const result = await evaluator.replay();
    expect(result.evaluations[0]).toMatchObject({ candidate_id: candidate.id, route: "digest", decision_confidence: 0.9, baseline: { status: "queued" } });
    expect(result.evaluations[0]!.projects).toHaveLength(2);
    expect(JSON.stringify(calls[0]!.state)).toContain("Original release notes");
    expect((await evaluator.replay()).cached).toBe(1);
    expect(calls).toHaveLength(1);
    const previous = repository.getSettings();
    expect(projectRadarSettingsFingerprint({ ...previous, updated_at: "2030-01-01" })).toBe(projectRadarSettingsFingerprint(previous));
    repository.saveSettings({ ...previous, projects: previous.projects.map((project) => ({ ...project, focus: [...project.focus, "New focus"] })) });
    expect((await evaluator.replay()).cached).toBe(0);
    expect(calls).toHaveLength(2);
    fixtureData.evidence("Original release notes changed with an additional API");
    expect((await evaluator.replay()).cached).toBe(0);
    expect(calls).toHaveLength(3);
    expect((await candidates.get(candidate.id))!.status).toBe("queued");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing original evidence records an explicit local review without model cost", async () => {
  const { dir, repository, candidates, state } = await fixture();
  let calls = 0;
  try {
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow" });
    state.putRecord("intelligence_briefs", "scan", { sources: [] });
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, provider: { evaluate: async (request) => { calls++; return response(request); } }, now: () => now });
    expect((await evaluator.replay()).evaluations[0]).toMatchObject({ route: "review", model: "policy:no-evidence", decision_confidence: 0 });
    expect(calls).toBe(0);
    expect(repository.getUsage("2026-09-22").evaluations).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider failures do not fabricate evaluations, leak errors or allow unlimited same-input retry", async () => {
  const { dir, repository, candidates, state } = await fixture();
  let calls = 0;
  try {
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow" });
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, provider: { evaluate: async () => { calls++; throw new Error("secret-token upstream body"); } }, now: () => now });
    expect(await evaluator.replay()).toMatchObject({ evaluations: [], failed: 1 });
    expect(repository.listEvaluations()).toEqual([]);
    expect(repository.getUsage("2026-09-22")).toMatchObject({ evaluations: 1, failures: 1, pending: 0 });
    expect(repository.getUsage("2026-09-22").input_tokens).toBeGreaterThan(1_000);
    expect(await evaluator.replay()).toMatchObject({ budget_exhausted: false, skipped: 1 });
    expect(calls).toBe(1);
    expect(JSON.stringify(state.db.query("SELECT * FROM project_radar_usage").all())).not.toContain("secret-token");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("simultaneous replays reserve one provider call and low confidence routes to review", async () => {
  const { dir, repository, candidates } = await fixture();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow" });
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => now, provider: { evaluate: async (request) => {
      calls++; await blocked; return response(request, 0.4);
    } } });
    const first = evaluator.replay();
    const second = evaluator.replay();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const results = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(results.flatMap((result) => result.evaluations)[0]).toMatchObject({ route: "review", decision_confidence: 0.4 });
    expect(repository.getUsage("2026-09-22")).toMatchObject({ evaluations: 1, input_tokens: 100, pending: 0 });
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test("a budget too small for a request blocks provider calls before spending", async () => {
  const { dir, repository, candidates } = await fixture();
  let calls = 0;
  try {
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow", daily_token_limit: 1_000 });
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => now, provider: { evaluate: async (request) => { calls++; return response(request); } } });
    expect((await evaluator.replay()).budget_exhausted).toBe(true);
    expect(calls).toBe(0);
    expect(repository.getUsage("2026-09-22").evaluations).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("new related history invalidates cache and duplicate events are held even with strong model scores", async () => {
  const { dir, repository, candidates, candidate } = await fixture();
  let calls = 0;
  try {
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow" });
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => now,
      provider: { evaluate: async (request) => { calls++; return response(request); } } });
    expect((await evaluator.replay({ candidate_ids: [candidate.id] })).evaluations[0]!.route).toBe("digest");
    await candidates.ingest({ scan_id: "older", member_id: "member", push_threshold: 0.7, history_hours: 72,
      now: new Date(now.getTime() - 60_000), evaluations: [{ event_key: candidate.event_key, headline: "Original release report", brief: "Known original facts",
        url: "https://example.com/older", source: "official", importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9,
        push_worthy: true, rationale: "earlier source", is_update: false }] });
    const result = await evaluator.replay({ candidate_ids: [candidate.id] });
    expect(result.cached).toBe(0);
    expect(result.evaluations[0]!.route).toBe("hold");
    expect(calls).toBe(2);
    await candidates.recordFeedback(candidate.id, "valuable", "web");
    expect(repository.feedbackCounts()).toEqual({ valuable: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid response is charged using actual usage but never saved as an evaluation", async () => {
  const { dir, repository, candidates } = await fixture();
  try {
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow" });
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => now,
      provider: { evaluate: async () => ({ model: "jev-test", answers: {}, usage: { inputTokens: 123 } }) } });
    expect(await evaluator.replay()).toMatchObject({ failed: 1, evaluations: [] });
    expect(repository.getUsage("2026-09-22")).toMatchObject({ failures: 1, input_tokens: 123 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("AI-only replay never sends finance candidates, including explicit IDs", async () => {
  const { dir, repository, candidates } = await fixture();
  let calls = 0;
  try {
    const [finance] = await candidates.ingest({ domain: "finance", scan_id: "finance", member_id: "finance", push_threshold: 0.7, history_hours: 72, now,
      evaluations: [{ event_key: "finance", headline: "Finance material", brief: "Finance", url: "https://example.com/finance", source: "official",
        importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9, push_worthy: true, rationale: "test", is_update: false }] });
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow" });
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => now,
      provider: { evaluate: async (request) => { calls++; return response(request); } } });
    expect((await evaluator.replay({ candidate_ids: [finance!.id] })).evaluations).toEqual([]);
    expect(calls).toBe(0);
    expect((await evaluator.replay()).evaluations.every((evaluation) => evaluation.candidate_id !== finance!.id)).toBe(true);
    expect(calls).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("automatic batches advance past ten cached candidates", async () => {
  const { dir, repository, candidates, state } = await fixture();
  try {
    for (let index = 0; index < 11; index++) {
      const id = `scan-${index}`;
      const url = `https://example.com/item-${index}`;
      await candidates.ingest({ scan_id: id, member_id: "member", push_threshold: 0.7, history_hours: 72,
        now: new Date(now.getTime() - (index + 1) * 60_000), evaluations: [{ event_key: id, headline: id, brief: id, url, source: "official",
          importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9, push_worthy: true, rationale: "test", is_update: false }] });
      state.putRecord("intelligence_briefs", id, { sources: [{ title: id, link: url, source: "official", summary: "Original collected material" }] });
    }
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow", daily_token_limit: 250_000 });
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => now,
      provider: { evaluate: async (request) => response(request) } });
    const first = await evaluator.replay();
    expect(first.evaluations).toHaveLength(10);
    const next = await evaluator.replay();
    const oldIds = new Set(first.evaluations.map((item) => item.candidate_id));
    expect(next.evaluations.slice(0, 2).every((item) => !oldIds.has(item.candidate_id))).toBe(true);
    expect(next.cached).toBe(8);
    expect(repository.getUsage("2026-09-22").evaluations).toBe(12);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rules share the daily evaluation limit with models, reuse cache and charge no model tokens", async () => {
  const { dir, repository, candidates, candidate, evidence } = await fixture();
  try {
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow", daily_evaluation_limit: 1 }, now);
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => now });
    const results = await Promise.all([evaluator.replay(), evaluator.replay()]);
    expect(results.flatMap((result) => result.evaluations).every((item) => item.evaluation_method === "rules")).toBe(true);
    expect(repository.listEvaluations()).toHaveLength(1);
    expect(repository.ruleUsage("2026-09-22")).toBe(1);
    expect(repository.ruleUsage("2026-09-23")).toBe(0);
    expect((await evaluator.replay()).cached).toBe(1);
    evidence("Updated original material must not bypass today's limit");
    expect(await evaluator.replay()).toMatchObject({ budget_exhausted: true, evaluations: [], skipped: 1 });
    let modelCalls = 0;
    const modelEvaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => now,
      provider: { evaluate: async (request) => { modelCalls++; return response(request); } } });
    expect((await modelEvaluator.replay({ candidate_ids: [candidate.id] })).budget_exhausted).toBe(true);
    expect(modelCalls).toBe(0);
    expect(repository.getUsage("2026-09-22")).toMatchObject({ evaluations: 0, input_tokens: 0, pending: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("automatic rules skip old candidates while an explicit replay can inspect retained history", async () => {
  const { dir, repository, candidates, candidate } = await fixture();
  try {
    const tomorrow = new Date(now.getTime() + 86_400_001);
    repository.saveSettings({ ...repository.getSettings(), mode: "shadow" }, tomorrow);
    const evaluator = new ProjectRadarEvaluator({ repository, candidates, now: () => tomorrow });
    expect((await evaluator.replay()).evaluations).toHaveLength(0);
    expect((await evaluator.replay({ candidate_ids: [candidate.id] })).evaluations).toHaveLength(1);
    expect(repository.getUsage("2026-09-23").input_tokens).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
