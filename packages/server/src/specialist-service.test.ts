import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SpecialistTaskRepository } from "./specialist-service";

test("specialist task envelope enforces typed operations and optimistic revisions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-specialist-task-"));
  const repository = new SpecialistTaskRepository(dataDir);
  const task = repository.create({
    id: "task-1", service_id: "intelligence.watch", service_version: 1, operation: "scan",
    trigger: "scheduled", status: "queued", current_stage: "collect",
    member_id: "qwen_intelligence", chief_member_id: "deepseek_reasoner",
    idempotency_key: "window-1", input: { window: "window-1" },
  });
  const running = repository.update(task.id, task.revision, {
    status: "running", current_stage: "summarize", summary: "来源已收集",
  });
  expect(running).toMatchObject({ revision: 2, status: "running", current_stage: "summarize" });
  expect(() => repository.update(task.id, task.revision, {
    status: "completed", current_stage: "candidate_gate", summary: "stale writer",
  })).toThrow("revision conflict");
  expect(() => repository.create({
    id: "task-2", service_id: "intelligence.watch", service_version: 1, operation: "arbitrary-shell",
    trigger: "manual", status: "queued", current_stage: "collect", input: {},
  })).toThrow("Unsupported");
  await rm(dataDir, { recursive: true, force: true });
});

test("service bindings only revise on change and task events keep a contiguous sequence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-specialist-events-"));
  const repository = new SpecialistTaskRepository(dataDir);
  const binding = {
    service_id: "intelligence.watch" as const,
    chief_member_id: "deepseek_reasoner",
    specialist_member_id: "qwen_intelligence",
    routing_reason: "capability match",
    capability_evidence: ["news-intelligence"],
    tool_grants: ["news-intelligence"],
  };
  repository.registerBinding(binding);
  repository.registerBinding(binding);
  expect(repository.bindings()[0]).toMatchObject({ revision: 1 });
  repository.registerBinding({ ...binding, routing_reason: "updated evidence" });
  expect(repository.bindings()[0]).toMatchObject({ revision: 2, routing_reason: "updated evidence" });

  const task = repository.create({
    id: "task-events", service_id: "intelligence.watch", service_version: 1, operation: "scan",
    trigger: "scheduled", status: "queued", current_stage: "collect", input: {},
  });
  for (let index = 0; index < 20; index += 1) {
    repository.appendEvent(task.id, {
      type: "evidence", stage: "collect", summary: `evidence-${index}`,
    });
  }
  expect(repository.get(task.id)?.events?.map((event) => event.seq))
    .toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
  await rm(dataDir, { recursive: true, force: true });
});
