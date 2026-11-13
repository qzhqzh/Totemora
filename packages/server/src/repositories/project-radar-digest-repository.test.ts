import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { StateDatabase } from "../state-database";
import { defaultProjectRadarSettings } from "../domains/intelligence/project-radar-policy";
import { applyProjectRadarDigestsMigration } from "../migrations/018-project-radar-digests";
import { ProjectRadarRepository } from "./project-radar-repository";
import { ProjectRadarDigestRepository, type ProjectRadarDigestSnapshot } from "./project-radar-digest-repository";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const now = new Date("2026-09-22T11:30:00.000Z");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "radar-digest-repo-")); directories.push(dir);
  const state = StateDatabase.open(dir); applyProjectRadarDigestsMigration(state.db);
  const radar = new ProjectRadarRepository(dir);
  const settings = radar.saveSettings({ ...defaultProjectRadarSettings(now), mode: "active" }, now);
  const candidates = new IntelligenceCandidateStore(dir);
  const [candidate] = await candidates.ingest({ scan_id: "scan", member_id: "member", push_threshold: 0.7, history_hours: 24, now,
    evaluations: [{ event_key: "event", headline: "release", brief: "brief", url: "https://example.com/item", source: "official",
      importance: 1, interest: 1, confidence: 1, novelty: 1, push_worthy: true, rationale: "evidence", is_update: false }] });
  const snapshot: ProjectRadarDigestSnapshot = {
    date: "2026-09-22", title: "title", body: "body", settings_fingerprint: "a".repeat(64), settings_updated_at: settings.updated_at,
    items: [{ candidate_id: candidate.id, evaluation_id: "evaluation", headline: "release", brief: "brief", url: candidate.url, project_names: ["Totemora"], reason: "relevant" }],
    envelope: { schema_version: 1, id: "project-radar:2026-09-22", idempotency_key: "project-radar:2026-09-22", domain: "ai", kind: "digest", title: "title", body: "body", priority: 3, tags: [] },
  };
  return { dir, state, radar, settings, candidates, candidate, snapshot, repository: new ProjectRadarDigestRepository(dir) };
}

test("two repository instances claim one immutable digest and fence completion", async () => {
  const f = await fixture(); const other = new ProjectRadarDigestRepository(f.dir);
  const first = f.repository.claim(f.snapshot, now)!;
  expect(first.status).toBe("sending");
  expect(other.claim(f.snapshot, now)).toBeUndefined();
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "pushing", claim_token: first.lease_token });
  expect(other.finish(first.date, "wrong-token", "completed", now)).toBe(false);
  expect(f.repository.finish(first.date, first.lease_token!, "completed", now)).toBe(true);
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "pushed", pushed_at: now.toISOString() });
  expect(other.claim(f.snapshot, now)).toBeUndefined();
});

test("stale sending becomes uncertain after restart and late worker cannot finish", async () => {
  const f = await fixture(); const claim = f.repository.claim(f.snapshot, now)!;
  const restarted = new ProjectRadarDigestRepository(f.dir);
  const later = new Date(now.getTime() + 5 * 60_000);
  expect(restarted.recoverStale(later)).toBe(1);
  expect(restarted.get(claim.date)?.status).toBe("uncertain");
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "delivery_unknown" });
  expect(f.repository.finish(claim.date, claim.lease_token!, "completed", later)).toBe(false);
  expect(restarted.claim(f.snapshot, later)).toBeUndefined();
});

test("legacy dispatch cannot recover or replay candidates owned by a digest", async () => {
  const f = await fixture(); const claim = f.repository.claim(f.snapshot, now)!;
  const [other] = await f.candidates.ingest({ scan_id: "second-scan", member_id: "member", push_threshold: 0.7, history_hours: 24, now,
    evaluations: [{ event_key: "separate-event", headline: "New compiler benchmark", brief: "Independent result",
      url: "https://another.example/benchmark", source: "another-official", importance: 1, interest: 1, confidence: 1,
      novelty: 1, push_worthy: true, rationale: "independent evidence", is_update: false }] });
  const legacy = await f.candidates.claimNext(0, now, "ai");
  expect(legacy?.id).toBe(other.id);
  await f.candidates.complete(other.id, legacy!.claim_token, now);
  const later = new Date(now.getTime() + 6 * 60_000);
  expect(await f.candidates.claimNext(0, later, "ai")).toBeUndefined();
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "pushing", claim_token: claim.lease_token });
  expect(f.repository.recoverStale(later)).toBe(1);
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "delivery_unknown" });
  // A later candidate status repair must still respect the digest's delivery record.
  f.state.db.query("UPDATE intelligence_candidates SET status='queued' WHERE id=?").run(f.candidate.id);
  expect(await f.candidates.claimNext(0, later, "ai")).toBeUndefined();
});

test("a lost candidate fencing token cannot be reported as completed", async () => {
  const f = await fixture(); const claim = f.repository.claim(f.snapshot, now)!;
  f.state.db.query("UPDATE intelligence_candidates SET claim_token='other-worker' WHERE id=?").run(f.candidate.id);
  expect(f.repository.finish(claim.date, claim.lease_token!, "completed", now)).toBe(true);
  expect(f.repository.get(claim.date)?.status).toBe("uncertain");
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "pushing", claim_token: "other-worker" });
});

test("known failure retries the original snapshot after five minutes and stops at three attempts", async () => {
  const f = await fixture(); let time = now;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = f.repository.claim({ ...f.snapshot, title: `changed-${attempt}` }, time)!;
    expect(claim.attempts).toBe(attempt);
    expect(claim.title).toBe("changed-1");
    expect(claim.envelope).toEqual(f.snapshot.envelope);
    f.repository.finish(claim.date, claim.lease_token!, "failed", time);
    expect(f.repository.claim(f.snapshot, new Date(time.getTime() + 1))).toBeUndefined();
    time = new Date(time.getTime() + 5 * 60_000);
  }
  expect(f.repository.get(f.snapshot.date)).toMatchObject({ status: "failed", attempts: 3 });
  expect(f.repository.claim(f.snapshot, time)).toBeUndefined();
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "failed" });
});

test("candidate claim races, changed settings, and a failed transaction never leave partial reservations", async () => {
  const f = await fixture();
  await f.candidates.claimNext(0, now);
  expect(f.repository.claim(f.snapshot, now)).toBeUndefined();
  expect(f.repository.get(f.snapshot.date)).toBeUndefined();
  f.state.db.query("UPDATE intelligence_candidates SET status='queued',claim_token=NULL").run();
  f.radar.saveSettings({ ...f.settings, mode: "shadow" }, now);
  expect(f.repository.claim(f.snapshot, now)).toBeUndefined();
  f.radar.saveSettings(f.settings, now);
  f.state.db.exec("CREATE TRIGGER reject_digest_item BEFORE INSERT ON project_radar_digest_items BEGIN SELECT RAISE(ABORT,'blocked'); END");
  expect(() => f.repository.claim(f.snapshot, now)).toThrow("blocked");
  expect(f.repository.get(f.snapshot.date)).toBeUndefined();
  expect(f.repository.isClaimed(f.candidate.id)).toBe(false);
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "queued" });
});

test("empty day is terminal and runtime windows/fallback persist across repository instances", async () => {
  const f = await fixture(); const other = new ProjectRadarDigestRepository(f.dir);
  expect(f.repository.claim({ ...f.snapshot, items: [], body: "", envelope: undefined }, now)?.status).toBe("empty");
  expect(other.claim(f.snapshot, now)).toBeUndefined();
  expect(f.repository.claimEvaluationWindow("2026-09-22T11:00:00Z")).toBe(true);
  expect(other.claimEvaluationWindow("2026-09-22T11:00:00Z")).toBe(false);
  expect(other.claimEvaluationWindow("2026-09-22T10:00:00Z")).toBe(false);
  expect(other.claimEvaluationWindow("2026-09-22T12:00:00Z")).toBe(true);
  other.setFallbackUntil("2026-09-22T12:00:00Z");
  expect(f.repository.getFallbackUntil()).toBe("2026-09-22T12:00:00.000Z");
  f.repository.setFallbackUntil(null);
  expect(other.getFallbackUntil()).toBeUndefined();
});
