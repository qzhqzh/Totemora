import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { StateDatabase } from "../state-database";
import { ProjectRadarRepository } from "./project-radar-repository";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "radar-repo-"));
  const candidates = new IntelligenceCandidateStore(dir);
  const [candidate] = await candidates.ingest({ scan_id: "scan", member_id: "member", push_threshold: 0.7, history_hours: 72,
    evaluations: [{ event_key: "release", headline: "Release", brief: "Generated summary", url: "https://example.com/release", source: "official",
      importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9, push_worthy: true, rationale: "test", is_update: false }] });
  return { dir, candidate: candidate!, repo: new ProjectRadarRepository(dir), state: StateDatabase.open(dir) };
}

test("budget transactions fence duplicate inputs and concurrent callers, failures retain reserved tokens", async () => {
  const { dir, candidate, repo } = await fixture();
  try {
    const input = { day: "2026-09-22", candidate_id: candidate.id, cache_key: "a".repeat(64), input_tokens: 600, evaluation_limit: 2, token_limit: 1_000 };
    const results = await Promise.all(Array.from({ length: 5 }, async () => repo.reserveBudget(input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(repo.reserveBudget({ ...input, cache_key: "b".repeat(64) })).toBeUndefined();
    repo.settleBudget(results.find(Boolean)!.id, undefined, true, "failed");
    expect(repo.getUsage(input.day)).toMatchObject({ evaluations: 1, input_tokens: 600, failures: 1, pending: 0 });
    expect(repo.reserveBudget(input)).toBeUndefined();
    const next = repo.reserveBudget({ ...input, cache_key: "b".repeat(64), input_tokens: 400 });
    expect(next).toBeDefined();
    repo.settleBudget(next!.id, 10);
    repo.settleBudget(next!.id, 0); // Completion cannot refund the same reservation twice.
    expect(repo.getUsage(input.day)).toMatchObject({ evaluations: 2, input_tokens: 610, failures: 1 });
    expect(repo.reserveBudget({ ...input, cache_key: "c".repeat(64), input_tokens: 1 })).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("source evidence must match scan and source URL; summaries are never treated as originals", async () => {
  const { dir, candidate, repo, state } = await fixture();
  try {
    expect(repo.getEvidence(candidate)).toEqual([]);
    state.putRecord("intelligence_briefs", "scan", { sources: [{ title: "Headline", link: candidate.url }] });
    expect(repo.getEvidence(candidate)).toEqual([]);
    state.putRecord("intelligence_briefs", "scan", { sources: [
      { title: "Another", link: "https://example.com/other", summary: "Unrelated raw text" },
      { title: "Release", link: candidate.url, source: "official", summary: "Original collected source material" },
    ] });
    expect(repo.getEvidence(candidate)).toEqual([{ title: "Release", url: candidate.url, source: "official", text: "Original collected source material", published_at: undefined }]);
    expect(repo.getEvidence({ ...candidate, scan_id: "elsewhere" })).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("settings round trip is complete and defaults are stable", async () => {
  const { dir, repo } = await fixture();
  try {
    expect(repo.getSettings().updated_at).toBe("1970-01-01T00:00:00.000Z");
    expect(() => repo.saveSettings({ mode: "active" })).toThrow();
    const settings = repo.saveSettings({ ...repo.getSettings(), mode: "shadow" });
    expect(repo.getSettings()).toEqual(settings);
    expect(repo.feedbackCounts()).toEqual({});
  } finally { await rm(dir, { recursive: true, force: true }); }
});
