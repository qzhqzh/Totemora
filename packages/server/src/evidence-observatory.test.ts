import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig } from "@totemora/core";
import { EvidenceObservatory } from "./evidence-observatory";
import { IntelligenceCandidateStore } from "./intelligence-candidate-store";
import { MemberStateStore } from "./member-state-store";
import { StateDatabase } from "./state-database";

test("evidence overview separates operations, outcomes, system failures and candidate value", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-evidence-overview-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const state = StateDatabase.open(dataDir);
  state.putRecord("intelligence_briefs", "scan-1", {
    id: "scan-1", member_id: "qwen_intelligence", title: "scan", summary: "scan",
    items: [], sources: [], warnings: [], pushed_messages: 0, status: "completed",
    created_at: new Date().toISOString(),
    source_gate: { collected: 8, out_of_scope: 3, history_suppressed: 2, model_evaluated: 3 },
  });
  const [candidate] = await new IntelligenceCandidateStore(dataDir).ingest({
    domain: "ai", scan_id: "scan-1", member_id: "qwen_intelligence", push_threshold: 0.7, history_hours: 72,
    evaluations: [{
      event_key: "event", headline: "AI Agent release", brief: "new release",
      url: "https://example.com/agent", source: "example.com",
      importance: 1, interest: 1, confidence: 1, novelty: 1,
      push_worthy: true, rationale: "test", is_update: false,
    }],
  });
  await new IntelligenceCandidateStore(dataDir).recordFeedback(candidate!.id, "valuable", "web");
  const members = new MemberStateStore(dataDir, config);
  await members.remember({
    member_id: "qwen_intelligence", kind: "operation", verified: true,
    credit_type: "operation", credit_value: 0, source_id: "scan-1", summary: "scan",
  });
  await mkdir(join(dataDir, "benchmarks"));
  await writeFile(join(dataDir, "benchmarks", "proof.json"), JSON.stringify({
    schema_version: 1, id: "benchmark-1", created_at: "2026-08-12T08:00:00.000Z",
    suite: { id: "core-proof", version: 1, task_count: 10 }, pricing_status: "partial",
    summary: {
      tribe: { attempted: 10, structural_pass_rate: 0.8, total_tokens: 1_000,
        strong_model_tokens: 300, known_cost_usd: 0.01, pricing_gap_cases: 2 },
    },
  }));
  await members.remember({
    member_id: "qwen_intelligence", kind: "success", verified: true,
    credit_type: "user_feedback", credit_value: 1, source_type: "candidate_feedback",
    source_id: `${candidate!.id}:valuable`, summary: "valuable",
  });
  await members.remember({
    member_id: "qwen_intelligence", kind: "system_failure", verified: true,
    source_id: "timeout", summary: "timeout",
  });

  const overview = await new EvidenceObservatory(dataDir, config).overview();
  expect(overview.candidate_funnels.find((item) => item.domain === "ai")).toMatchObject({
    scans: 1, sources_collected: 8, sources_out_of_scope: 3,
    sources_history_suppressed: 2, sources_sent_to_model: 3,
    candidates_evaluated: 1, candidates_queued: 1, valuable_candidates: 1,
  });
  expect(overview.member_outcomes.find((item) => item.member_id === "qwen_intelligence")).toMatchObject({
    operations: 1, judged_outcomes: 1, accepted_outcomes: 1,
    member_failures: 0, system_failures: 1, acceptance_rate: 1,
  });
  expect(overview.recent_benchmarks[0]).toMatchObject({
    suite_id: "core-proof", task_count: 10, pricing_status: "partial",
    strategies: [{ id: "tribe", structural_pass_rate: 0.8, pricing_gap_cases: 2 }],
  });
  await rm(dataDir, { recursive: true, force: true });
});
