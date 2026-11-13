import { expect, test } from "bun:test";
import { evaluateProjectRadarBaseline } from "./project-radar-baseline";
import type { IntelligenceCandidate } from "../../intelligence-candidate-store";

const project = { id: "echome", name: "EchoMe", goal: "项目上下文", focus: ["检索", "memory"], exclude: ["广告"], enabled: true };
const candidate = { scores: { confidence: 0.9, novelty: 0.9 }, status: "queued", is_update: false } as IntelligenceCandidate;
const evidence = [{ title: "新检索方法", text: "官方材料描述检索方式与验证条件。", url: "https://example.com/source", source: "official" }];

test("rule matches cite supplied evidence and never manufacture model confidence or urgency", () => {
  const result = evaluateProjectRadarBaseline({ candidate, projects: [project], evidence, same_event: false });
  expect(result).toMatchObject({ evaluation_method: "rules", route: "digest", decision_confidence: null, urgency: 0 });
  expect(result.projects).toEqual([{ project_id: "echome", relevance: 1, confidence: null, matched_terms: ["检索"] }]);
});

test("missing evidence, exclusions, weak facts and duplicate events never become recommendations", () => {
  const evaluate = (changes = {}) => evaluateProjectRadarBaseline({ candidate, projects: [project], evidence, same_event: false, ...changes });
  expect(evaluate({ evidence: [] }).route).toBe("review");
  expect(evaluate({ evidence: [{ ...evidence[0], text: "检索广告" }] }).route).toBe("hold");
  expect(evaluate({ candidate: { ...candidate, scores: { confidence: 0.2, novelty: 0.9 } } }).route).toBe("review");
  expect(evaluate({ candidate: { ...candidate, status: "held" } }).route).toBe("hold");
  expect(evaluate({ same_event: true }).route).toBe("hold");
  expect(evaluate({ projects: [{ ...project, enabled: false }] }).route).toBe("hold");
});

test("ASCII terms match words, not unrelated substrings, and generated summaries are not evidence", () => {
  const result = evaluateProjectRadarBaseline({ candidate: { ...candidate, brief: "AI memory" },
    projects: [{ ...project, focus: ["AI"] }], evidence: [{ ...evidence[0], title: "News", text: "said a claim" }], same_event: false });
  expect(result.route).toBe("hold");
});
