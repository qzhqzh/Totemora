import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPlaygroundApp } from "./app";
import { IntelligenceCandidateStore } from "./intelligence-candidate-store";
import { StateDatabase } from "./state-database";

test("without Jev, source evidence becomes a private action, durable decision and honest handoff draft", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "radar-actions-api-"));
  const root = resolve(import.meta.dir, "../../..");
  const app = createPlaygroundApp({ dataDir, configDir: resolve(root, "configs/example"), projectRoot: root, operatorToken: "radar-test" });
  const call = (path = "", method = "GET", body?: unknown, auth = true) => app.fetch(new Request(`http://localhost/api/intelligence/radar${path}`, {
    method, headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer radar-test" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  try {
    const { settings } = await (await call()).json();
    settings.projects = [{ id: "echome", name: "EchoMe", goal: "改善检索", focus: ["检索"], exclude: [], enabled: true }];
    expect((await call("/settings", "PUT", { ...settings, mode: "shadow" })).status).toBe(200);
    const [candidate] = await new IntelligenceCandidateStore(dataDir).ingest({ scan_id: "original", member_id: "qwen_intelligence",
      push_threshold: 0.7, history_hours: 72, evaluations: [{ event_key: "retrieval", headline: "检索更新", brief: "候选摘要",
        url: "https://example.com/retrieval", source: "official", importance: 0.9, interest: 0.9, confidence: 0.9,
        novelty: 0.9, push_worthy: true, rationale: "材料充分", is_update: false }] });
    StateDatabase.open(dataDir).putRecord("intelligence_briefs", "original", { sources: [{ title: "检索更新",
      link: candidate.url, summary: "原始采集材料：检索接口新增可验证的过滤条件。", source: "official" }] });
    const evaluated = await call("/evaluate", "POST", { candidate_ids: [candidate.id] });
    expect(evaluated.status).toBe(200);
    expect((await evaluated.json()).evaluations[0]).toMatchObject({ evaluation_method: "rules", decision_confidence: null });
    expect((await call("/actions", "GET", undefined, false)).status).toBe(401);
    const response = await call("/actions");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { actions } = await response.json();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ method: "rules", status: "proposed", project_id: "echome" });
    const path = `/actions/${actions[0].id}`;
    expect((await call(`${path}/handoff`)).status).toBe(409);
    expect((await call(`${path}/decision`, "POST", { decision: "accept", idempotency_key: "accept-1", source: "telegram" })).status).toBe(400);
    expect((await call(`${path}/decision`, "POST", { decision: "complete", idempotency_key: "accept-1" })).status).toBe(400);
    expect((await call(`${path}/decision`, "POST", { decision: "accept", idempotency_key: "accept-1" })).status).toBe(200);
    expect((await call(`${path}/decision`, "POST", { decision: "accept", idempotency_key: "accept-1" })).status).toBe(200);
    expect((await call(`${path}/decision`, "POST", { decision: "dismiss", idempotency_key: "dismiss-1" })).status).toBe(409);
    expect(await (await call(`${path}/handoff`)).json()).toMatchObject({ status: "draft", submitted: false,
      ready: false, missing_fields: ["project_id", "phase_id"] });
    expect((await call("/actions/missing/handoff")).status).toBe(404);
    expect((await (await call("/actions")).json()).actions[0]).toMatchObject({ status: "accepted", decision_source: "web" });
    expect((await new IntelligenceCandidateStore(dataDir).get(candidate.id))?.status).toBe("queued");
    expect((await (await call()).json()).usage).toMatchObject({ evaluations: 0, rules_evaluations: 1, input_tokens: 0 });
    const digest = await (await call("/digest")).json();
    expect(digest.items[0]).toMatchObject({ action_id: actions[0].id });
    expect(digest.body).toContain("建议：");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
