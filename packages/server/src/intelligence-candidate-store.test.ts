import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IntelligenceCandidateStore } from "./intelligence-candidate-store";
import { StateDatabase } from "./state-database";

const strong = { event_key: "ai-agent-release", headline: "AI Agent 发布", brief: "出现重要更新", url: "https://example.com/a", source: "example.com", importance: 0.9, interest: 1, confidence: 0.9, novelty: 1, push_worthy: true, rationale: "命中关注且有新事实", is_update: false };

test("candidate pool queues value, holds duplicate and spaces pushes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-candidates-"));
  const store = new IntelligenceCandidateStore(dataDir);
  const now = new Date("2026-07-20T00:00:00.000Z");
  const [candidate] = await store.ingest({ scan_id: "scan-1", member_id: "qwen_intelligence", evaluations: [strong], push_threshold: 0.7, history_hours: 72, now });
  expect(candidate?.status).toBe("queued");
  const claimed = await store.claimNext(60_000, now);
  expect(claimed?.id).toBe(candidate?.id);
  await store.complete(claimed!.id, now);
  expect(await store.claimNext(60_000, new Date(now.getTime() + 30_000))).toBeUndefined();
  const [duplicate] = await store.ingest({ scan_id: "scan-2", member_id: "qwen_intelligence", evaluations: [strong], push_threshold: 0.7, history_hours: 72, now: new Date(now.getTime() + 61_000) });
  expect(duplicate).toMatchObject({ status: "held", duplicate_of: candidate?.id });
  await rm(dataDir, { recursive: true, force: true });
});

test("candidate pool allows a substantive update to a pushed event", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-candidate-update-"));
  const store = new IntelligenceCandidateStore(dataDir);
  const now = new Date("2026-07-20T00:00:00.000Z");
  const [first] = await store.ingest({ scan_id: "scan-1", member_id: "qwen_intelligence", evaluations: [strong], push_threshold: 0.7, history_hours: 72, now });
  await store.claimNext(60_000, now); await store.complete(first!.id, now);
  const [update] = await store.ingest({ scan_id: "scan-2", member_id: "qwen_intelligence", evaluations: [{ ...strong, headline: "AI Agent 发布关键修复", novelty: 0.9, is_update: true }], push_threshold: 0.7, history_hours: 72, now: new Date(now.getTime() + 61_000) });
  expect(update?.status).toBe("queued");
  await rm(dataDir, { recursive: true, force: true });
});

test("candidate pool suppresses a reworded headline even when the model changes its event key", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-candidate-similar-"));
  const store = new IntelligenceCandidateStore(dataDir);
  const first = await store.ingest({
    scan_id: "scan-1", member_id: "qwen_intelligence", push_threshold: 0.7, history_hours: 72,
    evaluations: [{ ...strong, event_key: "release-one", headline: "OpenAI 发布新的智能体编排协议", url: "https://example.com/one" }],
  });
  const second = await store.ingest({
    scan_id: "scan-2", member_id: "qwen_intelligence", push_threshold: 0.7, history_hours: 72,
    evaluations: [{ ...strong, event_key: "totally-different-key", headline: "OpenAI 正式发布新智能体编排协议", url: "https://example.com/two" }],
  });
  expect(first[0]!.status).toBe("queued");
  expect(second[0]).toMatchObject({ status: "held", duplicate_of: first[0]!.id });
  await rm(dataDir, { recursive: true, force: true });
});

test("candidate pool quarantines a stale in-flight delivery instead of risking a duplicate push", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-candidate-unknown-"));
  const store = new IntelligenceCandidateStore(dataDir);
  const now = new Date("2026-07-20T00:00:00.000Z");
  const [candidate] = await store.ingest({ scan_id: "scan-1", member_id: "qwen_intelligence", evaluations: [strong], push_threshold: 0.7, history_hours: 72, now });
  await store.claimNext(60_000, now);
  await store.claimNext(60_000, new Date(now.getTime() + 5 * 60_000));
  expect((await store.list()).find((item) => item.id === candidate!.id)).toMatchObject({ status: "delivery_unknown" });
  await rm(dataDir, { recursive: true, force: true });
});

test("candidate pool quarantines legacy in-flight delivery without a claim timestamp", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-candidate-legacy-claim-"));
  const store = new IntelligenceCandidateStore(dataDir);
  const now = new Date("2026-07-20T00:00:00.000Z");
  const [candidate] = await store.ingest({
    scan_id: "scan-1", member_id: "qwen_intelligence",
    evaluations: [strong], push_threshold: 0.7, history_hours: 72, now,
  });
  await store.claimNext(0, now);
  StateDatabase.open(dataDir).db.query(
    "UPDATE intelligence_candidates SET claimed_at=NULL WHERE id=?",
  ).run(candidate!.id);
  expect(await store.claimNext(0, now)).toBeUndefined();
  expect((await store.list()).find((item) => item.id === candidate!.id)).toMatchObject({
    status: "delivery_unknown",
  });
  await rm(dataDir, { recursive: true, force: true });
});

test("two store instances atomically claim one candidate and feedback adjusts only future similar scores", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-candidate-multi-"));
  const first = new IntelligenceCandidateStore(dataDir);
  const second = new IntelligenceCandidateStore(dataDir);
  const [candidate] = await first.ingest({
    scan_id: "scan-1", member_id: "qwen_intelligence", evaluations: [{ ...strong,
      event_key: "ai-agents", headline: "AI Agent 新进展", url: "https://example.com/agent-1",
    }], push_threshold: 0.7, history_hours: 72,
  });
  const claims = await Promise.all([first.claimNext(0), second.claimNext(0)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  await first.recordFeedback(candidate!.id, "valuable", "web");
  const [next] = await second.ingest({
    scan_id: "scan-2", member_id: "qwen_intelligence", evaluations: [{ ...strong,
      event_key: "ai-agents-update", headline: "AI Agent 新进展更新", url: "https://example.com/agent-2",
      is_update: true,
    }], push_threshold: 0.7, history_hours: 72,
  });
  expect(next!.scores.feedback_adjustment).toBe(0.08);
  expect(next!.scores.base_total).toBeCloseTo(candidate!.scores.base_total);
  await rm(dataDir, { recursive: true, force: true });
});

test("candidate pool keeps only one channel delivery in flight across store instances", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-candidate-channel-lease-"));
  const first = new IntelligenceCandidateStore(dataDir);
  const second = new IntelligenceCandidateStore(dataDir);
  const now = new Date("2026-07-20T00:00:00.000Z");
  await first.ingest({
    scan_id: "scan-1", member_id: "qwen_intelligence", push_threshold: 0.7, history_hours: 72, now,
    evaluations: [
      { ...strong, event_key: "event-one", headline: "事件一", url: "https://example.com/one" },
      { ...strong, event_key: "event-two", headline: "完全不同的事件二", url: "https://example.com/two" },
    ],
  });
  const claimed = await first.claimNext(0, now);
  expect(claimed).toBeDefined();
  expect(await second.claimNext(0, now)).toBeUndefined();
  await first.complete(claimed!.id, claimed!.claim_token, now);
  expect(await second.claimNext(0, new Date(now.getTime() + 1))).toBeDefined();
  await rm(dataDir, { recursive: true, force: true });
});

test("opaque Bark open callback is idempotent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-candidate-open-"));
  const store = new IntelligenceCandidateStore(dataDir);
  const [candidate] = await store.ingest({
    scan_id: "scan-1", member_id: "qwen_intelligence",
    evaluations: [strong], push_threshold: 0.7, history_hours: 72,
  });
  const token = store.createOpenCallback(candidate!.id, candidate!.url);
  expect((await store.consumeOpenCallback(token))?.inserted).toBe(true);
  expect((await store.consumeOpenCallback(token))?.inserted).toBe(false);
  expect((await store.get(candidate!.id))?.feedback?.opened).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});
