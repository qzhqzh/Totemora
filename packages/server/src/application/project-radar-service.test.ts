import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { StateDatabase } from "../state-database";
import { ProjectRadarDigestRepository } from "../repositories/project-radar-digest-repository";
import { ProjectRadarService } from "./project-radar-service";
import { parseNotificationEnvelope, type NotificationEnvelopeV1 } from "../domains/notification/notification-envelope";
import type { NotificationDispatchResult } from "./notification-dispatcher";

test("failed model fallback survives same-input skipped retries and service restarts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "radar-service-"));
  const now = new Date("2026-09-22T08:00:00Z");
  let modelCalls = 0;
  let sends = 0;
  const options = { dataDir, now: () => now,
    provider: { evaluate: async () => { modelCalls++; throw new Error("upstream unavailable"); } },
    dispatcher: { dispatch: async () => { sends++; throw new Error("must not send"); } },
    authorizeEvaluation: async () => {}, authorizeDelivery: async () => {},
  };
  try {
    const service = new ProjectRadarService(options);
    service.saveSettings({ ...service.repository.getSettings(), mode: "active" });
    const [candidate] = await new IntelligenceCandidateStore(dataDir).ingest({ scan_id: "scan", member_id: "qwen_intelligence",
      push_threshold: 0.7, history_hours: 72, now,
      evaluations: [{ event_key: "release", headline: "Release", brief: "Version released", url: "https://example.com/release",
        source: "official", importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9, push_worthy: true, rationale: "fixture", is_update: false }] });
    StateDatabase.open(dataDir).putRecord("intelligence_briefs", "scan", {
      sources: [{ title: "Release", link: candidate!.url, source: "official", summary: "New release adds typed evaluation." }],
    });
    expect(service.shouldDeferLegacyPush()).toBe(true);
    expect((await service.evaluate()).failed).toBe(1);
    expect(service.shouldDeferLegacyPush()).toBe(false);
    const runtime = new ProjectRadarDigestRepository(dataDir);
    const fallback = runtime.getFallbackUntil();
    expect((await service.evaluate()).skipped).toBe(1);
    expect(runtime.getFallbackUntil()).toBe(fallback);
    expect(new ProjectRadarService(options).shouldDeferLegacyPush()).toBe(false);
    await service.runDue();
    await service.runDue();
    expect(modelCalls).toBe(1);
    expect(sends).toBe(0);
    now.setHours(now.getHours() + 1);
    expect(service.shouldDeferLegacyPush()).toBe(true);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("rules carry source evidence into an action and one scheduled message, then preserve the user's decision", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "radar-rules-flow-"));
  const now = new Date("2026-10-25T11:30:00Z");
  const sent: NotificationEnvelopeV1[] = [];
  const options = { dataDir, now: () => now, publicBaseUrl: "https://assistant.example.com",
    dispatcher: { dispatch: async ({ envelope }: { envelope: unknown }): Promise<NotificationDispatchResult> => {
      const parsed = parseNotificationEnvelope(envelope); sent.push(parsed);
      return { envelope_id: parsed.id, idempotency_key: parsed.idempotency_key, status: "completed",
        deliveries: [{ target_id: "test-only", channel: "ntfy", status: "completed", evidence: "fake accepted" }] };
    } }, authorizeEvaluation: async () => {}, authorizeDelivery: async () => {},
  };
  try {
    const service = new ProjectRadarService(options);
    service.saveSettings({ ...service.repository.getSettings(), mode: "active", digest_limit: 3,
      projects: [{ id: "echome", name: "EchoMe", goal: "改善项目检索", focus: ["检索"], exclude: [], enabled: true }] });
    const store = new IntelligenceCandidateStore(dataDir);
    const [candidate] = await store.ingest({ scan_id: "source", member_id: "qwen_intelligence", push_threshold: 0.7, history_hours: 72, now,
      evaluations: [{ event_key: "retrieval", headline: "检索更新", brief: "检索接口增加过滤条件", url: "https://example.com/retrieval",
        source: "official", importance: 0.9, interest: 0.9, confidence: 0.9, novelty: 0.9, push_worthy: true, rationale: "fixture", is_update: false }] });
    StateDatabase.open(dataDir).putRecord("intelligence_briefs", "source", {
      sources: [{ title: "检索接口更新", link: candidate.url, source: "official", summary: "原始发布材料说明了新增的检索过滤条件。" }],
    });
    expect((await service.runDue())?.digest).toMatchObject({ status: "completed" });
    const [action] = service.actions.list();
    expect(action).toMatchObject({ status: "proposed", method: "rules", candidate_id: candidate.id });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("建议：");
    expect(sent[0].body).toContain(candidate.url);
    expect(sent[0].click_url).toBe("https://assistant.example.com/#project-radar-panel");
    expect((await service.previewDigest()).items[0].action_id).toBe(action.id);
    service.actions.decide(action.id, { decision: "accept", idempotency_key: "user-confirmed", source: "web" });
    const restarted = new ProjectRadarService(options);
    await restarted.runDue();
    expect(sent).toHaveLength(1);
    expect(restarted.actions.handoff(action.id)).toMatchObject({ submitted: false, ready: false, status: "draft" });
    expect((await restarted.status()).usage).toMatchObject({ evaluations: 0, input_tokens: 0, rules_evaluations: 1 });
    expect((await store.get(candidate.id))?.status).toBe("pushed");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
