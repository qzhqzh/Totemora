import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentWork } from "../content-studio-service";
import { SpecialistTaskRepository } from "../specialist-service";
import type { NotificationDispatchResult } from "./notification-dispatcher";
import { ContentNotificationService } from "./content-notification-service";

function work(body = "一篇已经通过审校的草稿"): ContentWork {
  return {
    id: "work-1", format: "x_hot_post", status: "ready", topic: "定时内容",
    source: {
      candidate_id: "candidate-1", headline: "来源标题", brief: "brief",
      url: "https://example.com/source", provider: "example.com",
    },
    chief_member_id: "chief", assignments: [], contributions: [], title: "值得关注的新进展",
    body, revision: 2, copy_count: 0,
    usage: { calls: 3, input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    created_at: "2026-08-30T10:00:00.000Z", updated_at: "2026-08-30T10:05:00.000Z",
  };
}

function result(status: NotificationDispatchResult["status"]): NotificationDispatchResult {
  return {
    envelope_id: "content-draft-work-1", idempotency_key: "content:draft:work-1", status,
    deliveries: status === "completed"
      ? [{ target_id: "legacy-content", channel: "ntfy", status: "completed", evidence: "accepted" }]
      : [{ target_id: "legacy-content", channel: "ntfy", status: status === "uncertain" ? "uncertain" : "failed" }],
  };
}

test("scheduled content notification dispatches a bounded draft exactly once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-notify-"));
  const envelopes: any[] = [];
  try {
    const service = new ContentNotificationService({
      dataDir,
      dispatcher: { async dispatch(input) { envelopes.push(input.envelope); return result("completed"); } },
      now: () => new Date("2026-08-30T09:00:00Z"),
    });
    const first = await service.notify(work("测".repeat(4_000)), new Date("2026-08-30T10:10:00Z"));
    const replay = await service.notify(work(), new Date("2026-08-30T10:11:00Z"));
    expect(first).toMatchObject({ attempted: true, record: { status: "completed", attempts: 1 } });
    expect(replay).toMatchObject({ attempted: false, record: { status: "completed", attempts: 1 } });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ domain: "content", kind: "draft", source: { source_id: "candidate-1" } });
    expect(new TextEncoder().encode(envelopes[0].body).byteLength).toBeLessThanOrEqual(3_600);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("content notification backs off definite failures and never replays uncertain outcomes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-notify-retry-"));
  let calls = 0;
  try {
    const service = new ContentNotificationService({
      dataDir,
      dispatcher: { async dispatch() {
        calls += 1;
        return result(calls === 1 ? "failed" : "uncertain");
      } },
      now: () => new Date("2026-08-30T09:00:00Z"),
    });
    expect(await service.notify(work(), new Date("2026-08-30T10:00:00Z")))
      .toMatchObject({ attempted: true, record: { status: "failed", attempts: 1 } });
    expect(await service.notify(work(), new Date("2026-08-30T10:04:00Z")))
      .toMatchObject({ attempted: false, record: { status: "failed", attempts: 1 } });
    expect(await service.notify(work(), new Date("2026-08-30T10:06:00Z")))
      .toMatchObject({ attempted: true, record: { status: "uncertain", attempts: 2 } });
    expect(await service.notify(work(), new Date("2026-08-30T11:00:00Z")))
      .toMatchObject({ attempted: false, record: { status: "uncertain", attempts: 2 } });
    expect(calls).toBe(2);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("content notification records pre-cutover drafts without retroactive delivery", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-notify-cutover-"));
  let calls = 0;
  try {
    const ready = work();
    new SpecialistTaskRepository(dataDir).create({
      id: ready.id, service_id: "content.studio", service_version: 1,
      operation: ready.format, trigger: "scheduled", status: "completed", current_stage: "copy_ready",
      idempotency_key: ready.id, input: {}, result: ready, result_ref: ready.id,
    });
    const service = new ContentNotificationService({
      dataDir,
      dispatcher: { async dispatch() { calls += 1; return result("completed"); } },
      now: () => new Date("2026-08-30T11:00:00Z"),
    });
    expect(service.dueWorkIds(new Date("2026-08-30T11:01:00Z"))).toEqual([ready.id]);
    const first = await service.notify(ready, new Date("2026-08-30T11:01:00Z"));
    const repeated = await service.notify(ready, new Date("2026-08-30T11:02:00Z"));
    expect(first).toMatchObject({
      attempted: false, changed: true,
      record: { status: "suppressed", attempts: 0, suppression_reason: expect.any(String) },
    });
    expect(repeated).toMatchObject({ attempted: false, changed: false, record: { status: "suppressed" } });
    expect(service.dueWorkIds(new Date("2026-08-30T11:03:00Z"))).toEqual([]);
    expect(calls).toBe(0);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
