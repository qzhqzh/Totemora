import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { StateDatabase } from "../state-database";
import { defaultProjectRadarSettings, projectRadarSettingsFingerprint } from "../domains/intelligence/project-radar-policy";
import type { ProjectRadarEvaluation, ProjectRadarMode } from "../domains/intelligence/project-radar-types";
import { parseNotificationEnvelope, type NotificationEnvelopeV1 } from "../domains/notification/notification-envelope";
import { StaticNotificationTargetPolicy } from "../domains/notification/notification-target-policy";
import { ProjectRadarRepository } from "../repositories/project-radar-repository";
import { ProjectRadarDigestRepository } from "../repositories/project-radar-digest-repository";
import { ProjectRadarDigestService, type ProjectRadarDigestServiceOptions } from "./project-radar-digest-service";
import { NotificationDispatcher, type NotificationDispatchResult } from "./notification-dispatcher";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const due = new Date("2026-09-22T11:30:00.000Z");
async function fixture(mode: ProjectRadarMode = "active") {
  const dir = await mkdtemp(join(tmpdir(), "radar-digest-service-")); directories.push(dir);
  const state = StateDatabase.open(dir);
  const radar = new ProjectRadarRepository(dir);
  const settings = radar.saveSettings({ ...defaultProjectRadarSettings(due), mode }, new Date("2026-09-22T10:00:00Z"));
  const candidates = new IntelligenceCandidateStore(dir);
  const digests = new ProjectRadarDigestRepository(dir);
  let serial = 0;
  async function add() {
    serial++;
    const [candidate] = await candidates.ingest({ scan_id: `scan-${serial}`, member_id: "member", push_threshold: 0.7, history_hours: 24,
      now: new Date("2026-09-22T11:00:00Z"), evaluations: [{ event_key: `event-${serial}`, headline: `发布 ${serial}`, brief: "官方发布功能更新",
        url: `https://example.com/item-${serial}`, source: `official-${serial}`, importance: 1, interest: 1, confidence: 0.9, novelty: 1,
        push_worthy: true, rationale: "evidence", is_update: false }] });
    const evaluation: ProjectRadarEvaluation = { id: crypto.randomUUID(), candidate_id: candidate.id,
      baseline: { scores: candidate.scores, status: candidate.status }, projects: [{ project_id: "totemora", relevance: 0.9, confidence: 0.9 }],
      decision_confidence: 0.9, evidence_quality: 0.9, novelty: 0.9, urgency: 0.5, route: "digest", reason: "与项目相关，适合每日精选",
      model: "jev-test", question_version: "project-radar-v1", settings_fingerprint: projectRadarSettingsFingerprint(settings),
      input_fingerprint: serial.toString(16).padStart(64, "0"), created_at: "2026-09-22T11:10:00.000Z" };
    radar.saveEvaluation(evaluation);
    return { candidate, evaluation };
  }
  const first = await add();
  let current = due;
  const sent: NotificationEnvelopeV1[] = [];
  let authorizations = 0;
  const options: ProjectRadarDigestServiceOptions = { dataDir: dir, radarRepository: radar, now: () => current,
    authorize: async () => { authorizations++; }, dispatcher: { dispatch: async ({ envelope }) => {
      const parsed = parseNotificationEnvelope(envelope); sent.push(parsed); return completed(parsed);
    } } };
  return { dir, state, radar, settings, candidates, digests, add, ...first, options, sent,
    setNow: (value: Date) => { current = value; }, authorizations: () => authorizations, service: new ProjectRadarDigestService(options) };
}
function completed(envelope: NotificationEnvelopeV1): NotificationDispatchResult {
  return { envelope_id: envelope.id, idempotency_key: envelope.idempotency_key, status: "completed",
    deliveries: [{ target_id: "phone", channel: "bark", status: "completed", evidence: "accepted" }] };
}

test.each(["off", "shadow"] as const)("%s mode previews without sending or claiming", async (mode) => {
  const f = await fixture(mode);
  expect((await f.service.preview()).items).toHaveLength(1);
  expect(await f.service.runDue()).toBeUndefined();
  expect(f.sent).toHaveLength(0); expect(f.authorizations()).toBe(0);
  expect(f.digests.get("2026-09-22")).toBeUndefined();
});

test("Shanghai date and the one-hour compensation window select only the current scheduled digest", async () => {
  const f = await fixture();
  f.setNow(new Date("2026-09-22T11:29:59Z")); expect(await f.service.runDue()).toBeUndefined();
  f.setNow(new Date("2026-09-22T12:30:00Z")); expect(await f.service.runDue()).toBeUndefined();
  f.setNow(new Date("2026-09-22T16:00:00Z")); expect((await f.service.preview()).date).toBe("2026-09-23");
  expect(await f.service.runDue()).toBeUndefined();
  f.setNow(new Date("2026-09-22T12:29:59Z"));
  expect(await f.service.runDue()).toMatchObject({ date: "2026-09-22", status: "completed" });
  expect(f.sent).toHaveLength(1);
});

test("preview exactly matches the sent snapshot, claims only once, and completes original candidates", async () => {
  const f = await fixture(); const preview = await f.service.preview();
  const second = new ProjectRadarDigestService(f.options);
  await Promise.all([f.service.runDue(), second.runDue()]);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ title: preview.title, body: preview.body, kind: "digest", domain: "ai", idempotency_key: "project-radar:2026-09-22" });
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "pushed", pushed_at: due.toISOString() });
  await f.service.runDue(); expect(f.sent).toHaveLength(1);
  expect(await f.service.preview()).toEqual({ ...preview, status: "completed" });
});

test("authorization failure leaves no digest or candidate external-effect claim", async () => {
  const f = await fixture();
  const service = new ProjectRadarDigestService({ ...f.options, authorize: async () => { throw new Error("Denied"); } });
  await expect(service.runDue()).rejects.toThrow("Denied");
  expect(f.digests.get("2026-09-22")).toBeUndefined(); expect(f.sent).toHaveLength(0);
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "queued" });
});

test("settings changed during authorization cannot create an external-effect claim", async () => {
  const f = await fixture();
  const service = new ProjectRadarDigestService({ ...f.options, authorize: async () => {
    f.radar.saveSettings({ ...f.settings, mode: "off" }, due);
  } });
  expect(await service.runDue()).toBeUndefined(); expect(f.sent).toHaveLength(0);
  expect(f.digests.get("2026-09-22")).toBeUndefined();
});

test("authorization crossing the compensation deadline and a future retry cannot send early or late", async () => {
  const f = await fixture();
  f.state.db.query("UPDATE intelligence_candidates SET next_attempt_at='2026-09-22T12:00:00Z',status='retry_wait'").run();
  expect((await f.service.preview()).items).toHaveLength(0);
  f.state.db.query("UPDATE intelligence_candidates SET next_attempt_at=NULL,status='queued'").run();
  const service = new ProjectRadarDigestService({ ...f.options, authorize: async () => {
    f.setNow(new Date("2026-09-22T12:30:00Z"));
  } });
  expect(await service.runDue()).toBeUndefined(); expect(f.sent).toHaveLength(0);
  expect(f.digests.get("2026-09-22")).toBeUndefined();
});

test("held, already pushed, old and duplicate candidates cannot be promoted into a digest", async () => {
  const f = await fixture();
  for (const update of ["status='held'", "status='pushed',pushed_at='2026-09-22T11:20:00Z'",
    "status='queued',pushed_at=NULL,created_at='2026-09-21T11:29:59Z'",
    "created_at='2026-09-22T11:00:00Z',duplicate_of='prior'", "duplicate_of=NULL,confidence=0.2"] ) {
    f.state.db.exec(`UPDATE intelligence_candidates SET ${update}`);
    expect((await f.service.preview()).items).toHaveLength(0);
  }
  expect(await f.service.runDue()).toMatchObject({ status: "empty" }); expect(f.sent).toHaveLength(0);
  expect(f.authorizations()).toBe(0);
});

test("a delivered event is suppressed unless the candidate is a substantive update", async () => {
  const f = await fixture(); const other = await f.add();
  f.state.db.query("UPDATE intelligence_candidates SET status='pushed',pushed_at=? WHERE id=?").run(due.toISOString(), f.candidate.id);
  f.state.db.query("UPDATE intelligence_candidates SET event_key=? WHERE id=?").run(f.candidate.event_key, other.candidate.id);
  expect((await f.service.preview()).items).toHaveLength(0);
  f.state.db.query("UPDATE intelligence_candidates SET is_update=1 WHERE id=?").run(other.candidate.id);
  expect((await f.service.preview()).items.map((item) => item.candidate_id)).toEqual([other.candidate.id]);
});

test("changing settings invalidates prior fingerprints and evaluations from before the update", async () => {
  const f = await fixture();
  f.radar.saveSettings({ ...f.settings, digest_limit: 3 }, new Date("2026-09-22T10:10:00Z"));
  expect((await f.service.preview()).items).toHaveLength(0);
  f.radar.saveSettings(f.settings, new Date("2026-09-22T11:20:00Z"));
  expect((await f.service.preview()).items).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
});

test("fresh evaluation after editing a card admits recent candidates but excludes candidates older than 24 hours", async () => {
  const f = await fixture();
  const old = await f.add();
  f.state.db.query("UPDATE intelligence_candidates SET created_at='2026-09-21T11:29:59Z' WHERE id=?").run(old.candidate.id);
  const settings = f.radar.saveSettings({ ...f.settings, projects: f.settings.projects.map((project) =>
    ({ ...project, goal: `${project.goal}；评估最新功能` })) }, new Date("2026-09-22T11:20:00Z"));
  expect((await f.service.preview()).items).toHaveLength(0);
  for (const evaluation of [f.evaluation, old.evaluation]) f.radar.saveEvaluation({ ...evaluation,
    id: crypto.randomUUID(), settings_fingerprint: projectRadarSettingsFingerprint(settings), created_at: "2026-09-22T11:25:00Z" });
  expect((await f.service.preview()).items.map((item) => item.candidate_id)).toEqual([f.candidate.id]);
  expect(await f.service.runDue()).toMatchObject({ status: "completed" });
  expect(f.sent).toHaveLength(1);
  expect(await f.candidates.get(old.candidate.id)).toMatchObject({ status: "queued" });
});

test("the newest hold evaluation prevents an older digest evaluation from being selected", async () => {
  const f = await fixture();
  f.radar.saveEvaluation({ ...f.evaluation, id: crypto.randomUUID(), route: "hold", input_fingerprint: "f".repeat(64), created_at: "2026-09-22T11:20:00Z" });
  expect((await f.service.preview()).items).toHaveLength(0);
});

test("a hold saved at the same timestamp supersedes the earlier digest evaluation", async () => {
  const f = await fixture();
  f.radar.saveEvaluation({ ...f.evaluation, id: crypto.randomUUID(), route: "hold", input_fingerprint: "f".repeat(64) });
  expect((await f.service.preview()).items).toHaveLength(0);
});

test("bounded UTF-8 rendering preserves every selected URL and persists exactly the preview", async () => {
  const f = await fixture(); for (let i = 0; i < 6; i++) await f.add();
  f.state.db.query("UPDATE intelligence_candidates SET headline=?,brief=?").run("更新😀".repeat(150), "原始事实🧭".repeat(500));
  const preview = await f.service.preview();
  expect(preview.items).toHaveLength(5); expect(Buffer.byteLength(preview.body)).toBeLessThanOrEqual(3_200);
  expect(preview.body).not.toContain("�");
  for (const item of preview.items) { expect(preview.body).toContain(item.url); expect(preview.body).toContain(item.brief); }
  await f.service.runDue();
  expect(f.sent[0].body).toBe(preview.body);
  expect(f.digests.get(preview.date)?.items).toEqual(preview.items);
});

test("unsafe links are excluded while long HTTPS links remain whole", async () => {
  const f = await fixture();
  for (const url of ["http://example.com/a", "https://user:password@example.com/a", "javascript:alert(1)"]) {
    f.state.db.query("UPDATE intelligence_candidates SET url=?").run(url);
    expect((await f.service.preview()).items).toHaveLength(0);
  }
  const longUrl = `https://example.com/${"x".repeat(1_900)}`;
  f.state.db.query("UPDATE intelligence_candidates SET url=?").run(longUrl);
  const preview = await f.service.preview();
  expect(preview.items[0].url).toBe(longUrl); expect(preview.body).toContain(longUrl);
  expect(Buffer.byteLength(preview.body)).toBeLessThanOrEqual(3_200);
});

test("partial delivery retries the fixed envelope and existing Notifier replays successful target receipts", async () => {
  const f = await fixture(); let barkCalls = 0; let ntfyCalls = 0;
  const envelopes: string[] = [];
  const dispatcher = new NotificationDispatcher(f.dir, new StaticNotificationTargetPolicy([
    { id: "phone", channel: "bark", domains: ["ai"], enabled: true },
    { id: "feed", channel: "ntfy", domains: ["ai"], enabled: true },
  ]), [
    { channel: "bark", asset_id: "bark", deliver: async () => { barkCalls++; return { accepted: true, evidence: "accepted" }; } },
    { channel: "ntfy", asset_id: "ntfy", deliver: async () => { ntfyCalls++; if (ntfyCalls === 1) throw new Error("rejected"); return { accepted: true, evidence: "accepted" }; } },
  ]);
  const service = new ProjectRadarDigestService({ ...f.options, dispatcher: { dispatch: async (input) => {
    envelopes.push(JSON.stringify(input.envelope)); return dispatcher.dispatch(input);
  } } });
  expect(await service.runDue()).toMatchObject({ status: "failed" });
  f.state.db.query("UPDATE intelligence_candidates SET brief='later changed text'").run();
  f.setNow(new Date(due.getTime() + 299_999)); await service.runDue(); expect(envelopes).toHaveLength(1);
  f.setNow(new Date(due.getTime() + 300_000));
  expect(await service.runDue()).toMatchObject({ status: "completed" });
  expect(envelopes[0]).toBe(envelopes[1]); expect({ barkCalls, ntfyCalls }).toEqual({ barkCalls: 1, ntfyCalls: 2 });
  expect(f.authorizations()).toBe(2);
});

test.each(["unknown-target", "throw"] as const)("%s outcome is never automatically replayed", async (variant) => {
  const f = await fixture(); let calls = 0;
  const service = new ProjectRadarDigestService({ ...f.options, dispatcher: { dispatch: async ({ envelope }) => {
    calls++; if (variant === "throw") throw new Error("connection lost");
    return { ...completed(parseNotificationEnvelope(envelope)), status: "partial", deliveries: [
      { target_id: "phone", channel: "bark", status: "completed" }, { target_id: "feed", channel: "ntfy", status: "uncertain" },
    ] };
  } } });
  expect(await service.runDue()).toMatchObject({ status: "uncertain" });
  f.setNow(new Date(due.getTime() + 300_000)); await service.runDue();
  expect(calls).toBe(1); expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "delivery_unknown" });
});

test("restart marks an unfinished send uncertain and rejects a late successful completion", async () => {
  const f = await fixture(); let resolveDispatch!: (value: NotificationDispatchResult) => void; let sentEnvelope!: NotificationEnvelopeV1;
  const service = new ProjectRadarDigestService({ ...f.options, dispatcher: { dispatch: async ({ envelope }) => {
    sentEnvelope = parseNotificationEnvelope(envelope); return new Promise((resolve) => { resolveDispatch = resolve; });
  } } });
  const pending = service.runDue();
  while (!resolveDispatch) await new Promise((resolve) => setTimeout(resolve, 1));
  f.setNow(new Date(due.getTime() + 300_000));
  expect(await new ProjectRadarDigestService(f.options).runDue()).toMatchObject({ status: "uncertain" });
  resolveDispatch(completed(sentEnvelope));
  expect(await pending).toMatchObject({ status: "uncertain" }); expect(f.sent).toHaveLength(0);
  expect(await f.candidates.get(f.candidate.id)).toMatchObject({ status: "delivery_unknown" });
});
