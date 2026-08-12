import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig } from "@totemora/core";

import { ActionJournal } from "./action-journal";
import { IntelligenceCandidateStore } from "./intelligence-candidate-store";
import { IntelligenceDispatcher } from "./intelligence-dispatcher";
import { MemberStateStore } from "./member-state-store";
import { StateDatabase } from "./state-database";

test("dispatcher attempts every Bark target and retries only incomplete deliveries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-dispatch-isolation-"));
  await configureTargets(dataDir, [
    { id: "flaky", device_key: "flaky-key", domains: ["finance"], enabled: true, server_url: "https://flaky.example.test" },
    { id: "healthy", device_key: "healthy-key", domains: ["finance"], enabled: true, server_url: "https://healthy.example.test" },
  ]);
  const requests: string[] = [];
  let flakyAttempts = 0;
  const fetchImpl = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("flaky.example.test") && flakyAttempts++ === 0) return new Response("unavailable", { status: 503 });
    return Response.json({ code: 200 });
  }) as typeof fetch;
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const candidates = new IntelligenceCandidateStore(dataDir);
  const [candidate] = await candidates.ingest({
    domain: "finance", scan_id: "scan", member_id: "qwen_finance", push_threshold: 0.7, history_hours: 72,
    evaluations: [{
      event_key: "event", headline: "官方事件", brief: "事件摘要", url: "https://example.com/source",
      source: "official", importance: 1, interest: 1, confidence: 1, novelty: 1,
      push_worthy: true, rationale: "test", is_update: false,
    }],
  });
  const dispatcher = new IntelligenceDispatcher(dataDir, new MemberStateStore(dataDir, config), fetchImpl);

  await expect(dispatcher.pushNext("finance", 0, "finance.watch")).rejects.toThrow("unavailable");
  expect(await candidates.get(candidate!.id)).toMatchObject({ status: "retry_wait", attempt_count: 1 });
  expect(requests.some((url) => url.includes("healthy.example.test"))).toBe(true);
  StateDatabase.open(dataDir).db.query("UPDATE intelligence_candidates SET next_attempt_at=? WHERE id=?")
    .run(new Date(0).toISOString(), candidate!.id);
  expect(await dispatcher.pushNext("finance", 0, "finance.watch")).toMatchObject({ id: candidate!.id, status: "pushed" });
  expect(requests.filter((url) => url.includes("flaky.example.test"))).toHaveLength(2);
  expect(requests.filter((url) => url.includes("healthy.example.test"))).toHaveLength(1);
  expect((await new ActionJournal(dataDir).list()).filter((action) => action.status === "completed")).toHaveLength(2);
  await rm(dataDir, { recursive: true, force: true });
});

test("dispatcher blocks on an open Bark circuit without consuming a delivery retry", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-dispatch-circuit-"));
  await configureTargets(dataDir, [
    { id: "phone", device_key: "phone-key", domains: ["finance"], enabled: true, server_url: "https://phone.example.test" },
  ]);
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const candidates = new IntelligenceCandidateStore(dataDir);
  const [candidate] = await candidates.ingest({
    domain: "finance", scan_id: "scan", member_id: "qwen_finance", push_threshold: 0.7, history_hours: 72,
    evaluations: [{
      event_key: "blocked", headline: "等待恢复", brief: "事件摘要", url: "https://example.com/blocked",
      source: "official", importance: 1, interest: 1, confidence: 1, novelty: 1,
      push_worthy: true, rationale: "test", is_update: false,
    }],
  });
  const retryAfter = new Date(Date.now() + 30 * 60_000).toISOString();
  StateDatabase.open(dataDir).db.query(`
    INSERT INTO channel_state(channel,status,consecutive_failures,retry_after,last_error,updated_at)
    VALUES('bark:phone','open',3,?,'unavailable',?)
  `).run(retryAfter, new Date().toISOString());
  let requests = 0;
  const dispatcher = new IntelligenceDispatcher(dataDir, new MemberStateStore(dataDir, config), (async () => {
    requests += 1;
    return Response.json({ code: 200 });
  }) as unknown as typeof fetch);

  await expect(dispatcher.pushNext("finance", 0, "finance.watch")).rejects.toThrow("circuit is open");
  expect(await candidates.get(candidate!.id)).toMatchObject({
    status: "channel_blocked", attempt_count: 0, next_attempt_at: retryAfter,
  });
  expect(requests).toBe(0);
  await rm(dataDir, { recursive: true, force: true });
});

async function configureTargets(dataDir: string, targets: unknown[]): Promise<void> {
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-targets.json"), JSON.stringify(targets));
}
