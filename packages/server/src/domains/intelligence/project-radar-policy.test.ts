import { expect, test } from "bun:test";
import type { IntelligenceCandidate } from "../../intelligence-candidate-store";
import { defaultProjectRadarSettings, parseProjectRadarSettings, projectRadarDay, projectRadarRoute } from "./project-radar-policy";

const candidate = { domain: "ai", scores: { confidence: 0.9 }, is_update: false } as IntelligenceCandidate;
const strong = { candidate, has_evidence: true, projects: [{ project_id: "totemora", relevance: 0.95, confidence: 0.9 }],
  decision_confidence: 0.9, evidence_quality: 0.9, novelty: 0.9, urgency: 0.9, same_event: false };

test("radar settings default off with two editable project cards and strict bounds", () => {
  const defaults = defaultProjectRadarSettings();
  expect(defaults).toMatchObject({ mode: "off", timezone: "Asia/Shanghai", digest_time: "19:30", digest_limit: 5, daily_evaluation_limit: 100, daily_token_limit: 50_000 });
  expect(defaults.projects.map((item) => item.id)).toEqual(["totemora", "foundry-studio"]);
  expect(parseProjectRadarSettings({ ...defaults, mode: "shadow" }).mode).toBe("shadow");
  for (const change of [{ mode: "enabled" }, { projects: [] }, { digest_time: "24:00" }, { digest_limit: 6 },
    { daily_evaluation_limit: 501 }, { daily_token_limit: 250_001 }, { timezone: "UTC" }, { extra: true },
    { projects: [defaults.projects[0], defaults.projects[0]] }, { projects: [{ ...defaults.projects[0], goal: "line\nbreak" }] }]) {
    expect(() => parseProjectRadarSettings({ ...defaults, ...change })).toThrow();
  }
  expect(() => parseProjectRadarSettings({ mode: "active" })).toThrow();
});

test("decision confidence never replaces evidence and baseline confidence gates", () => {
  expect(projectRadarRoute(strong).route).toBe("immediate");
  expect(projectRadarRoute({ ...strong, urgency: 0.5 }).route).toBe("digest");
  expect(projectRadarRoute({ ...strong, has_evidence: false }).route).toBe("review");
  expect(projectRadarRoute({ ...strong, decision_confidence: 0.4 }).route).toBe("review");
  expect(projectRadarRoute({ ...strong, evidence_quality: 0.3 }).route).toBe("review");
  expect(projectRadarRoute({ ...strong, candidate: { ...candidate, scores: { ...candidate.scores, confidence: 0.2 } } }).route).toBe("review");
  expect(projectRadarRoute({ ...strong, candidate: { ...candidate, domain: "finance", evidence_tier: "S4" } }).route).toBe("review");
});

test("same-event updates require new facts and project relevance", () => {
  expect(projectRadarRoute({ ...strong, same_event: true }).route).toBe("hold");
  expect(projectRadarRoute({ ...strong, same_event: true, candidate: { ...candidate, is_update: true }, novelty: 0.7 }).route).toBe("hold");
  expect(projectRadarRoute({ ...strong, same_event: true, candidate: { ...candidate, is_update: true } }).route).toBe("immediate");
  expect(projectRadarRoute({ ...strong, candidate: { ...candidate, duplicate_of: "older" } }).route).toBe("hold");
  expect(projectRadarRoute({ ...strong, projects: [] }).route).toBe("hold");
  expect(projectRadarDay(new Date("2026-09-22T16:00:00Z"))).toBe("2026-09-23");
});
