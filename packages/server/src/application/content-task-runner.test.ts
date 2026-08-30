import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentWork, CreateContentInput } from "../content-studio-service";
import { SpecialistTaskRepository } from "../specialist-service";
import { ContentTaskRunner } from "./content-task-runner";

function work(id: string, status: ContentWork["status"]): ContentWork {
  return {
    id, format: "x_hot_post", status, topic: "定时主题",
    source: { candidate_id: `candidate-${id}`, headline: "来源", brief: "brief", url: "https://example.com", provider: "example" },
    chief_member_id: "chief", assignments: [], contributions: [],
    ...(status === "ready" ? { title: "草稿标题", body: "草稿正文" } : {}),
    revision: status === "ready" ? 2 : 1, copy_count: 0,
    usage: { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    created_at: "2026-08-30T10:00:00.000Z", updated_at: "2026-08-30T10:00:00.000Z",
  };
}

test("content runner notifies scheduled work but leaves web work silent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-runner-"));
  const tasks = new SpecialistTaskRepository(dataDir);
  let nextId = "web-work";
  let notificationCalls = 0;
  let dueInput: CreateContentInput | undefined;
  const works = new Map<string, ContentWork>();
  const content = {
    async createQueued() {
      const queued = work(nextId, "queued");
      works.set(queued.id, queued);
      return queued;
    },
    async execute(id: string) {
      const ready = work(id, "ready");
      works.set(id, ready);
      return ready;
    },
    async dueInput() {
      const result = dueInput;
      dueInput = undefined;
      return result;
    },
    get(id: string) { return works.get(id); },
  };
  const runner = new ContentTaskRunner({
    specialistTasks: tasks,
    async ensureServiceBindings() {},
    async getContentService() { return content; },
    async notifyScheduled(item) {
      notificationCalls += 1;
      return {
        attempted: true, changed: true,
        record: {
          schema_version: 1, work_id: item.id, status: "completed", attempts: 1,
          created_at: item.updated_at, updated_at: item.updated_at,
        },
      };
    },
  });
  try {
    await runner.enqueue({ format: "x_hot_post", topic: "manual" }, "web");
    await waitFor(() => tasks.get("web-work")?.status === "completed");
    expect(notificationCalls).toBe(0);

    nextId = "scheduled-work";
    dueInput = { format: "x_hot_post", topic: "scheduled" };
    await runner.runScheduled();
    await waitFor(() => tasks.get("scheduled-work")?.status === "completed");
    expect(notificationCalls).toBe(1);
    expect(tasks.get("scheduled-work")?.events?.at(-1)).toMatchObject({
      type: "evidence", stage: "dispatch", summary: "定时内容通知已记录为 completed",
    });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("scheduled runner retries a completed work after a restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-runner-retry-"));
  const tasks = new SpecialistTaskRepository(dataDir);
  const ready = work("existing-work", "ready");
  tasks.create({
    id: ready.id, service_id: "content.studio", service_version: 1,
    operation: ready.format, trigger: "scheduled", status: "completed",
    current_stage: "copy_ready", idempotency_key: ready.id, input: {}, result: ready, result_ref: ready.id,
  });
  let calls = 0;
  const runner = new ContentTaskRunner({
    specialistTasks: tasks,
    async ensureServiceBindings() {},
    async getContentService() {
      return {
        async createQueued() { throw new Error("not due"); },
        async execute() { throw new Error("not due"); },
        async dueInput() { return undefined; },
        get(id: string) { return id === ready.id ? ready : undefined; },
      };
    },
    async listDueScheduledNotifications() { return [ready.id]; },
    async notifyScheduled(item) {
      calls += 1;
      return {
        attempted: true, changed: true,
        record: {
          schema_version: 1, work_id: item.id, status: "completed", attempts: 1,
          created_at: item.updated_at, updated_at: item.updated_at,
        },
      };
    },
  });
  try {
    expect(await runner.runScheduled()).toBeUndefined();
    expect(calls).toBe(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for content task");
}
