import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActionJournal } from "./action-journal";

test("journals an external action and rejects a completed duplicate", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-action-journal-"));
  const journal = new ActionJournal(dataDir);
  let calls = 0;
  const input = {
    idempotency_key: "brief-1:bark:0", asset_id: "news-intelligence",
    member_id: "qwen_intelligence", action: "push_bark", request: { body: "hello" },
  };
  const completed = await journal.executeOnce(input, async () => { calls += 1; return { status: 200 }; }, (result) => `status ${result.status}`);
  expect(completed.record).toMatchObject({ status: "completed", attempts: 1, evidence: "status 200" });
  await expect(journal.executeOnce(input, async () => { calls += 1; return { status: 200 }; }, () => "again"))
    .rejects.toThrow("Action already completed");
  expect(calls).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});

test("reserves an idempotency key before concurrent external actions start", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-action-journal-race-"));
  const journal = new ActionJournal(dataDir);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const input = {
    idempotency_key: "candidate-1", asset_id: "news-intelligence",
    member_id: "qwen_intelligence", action: "push_bark", request: { body: "hello" },
  };
  const first = journal.executeOnce(input, async () => { calls += 1; await gate; return { status: 200 }; }, () => "ok");
  await Promise.resolve();
  const second = journal.executeOnce(input, async () => { calls += 1; return { status: 200 }; }, () => "duplicate");
  await expect(second).rejects.toThrow("already executing");
  release();
  await first;
  expect(calls).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});

test("two journal instances still execute one external side effect", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-action-cross-instance-"));
  const journals = [new ActionJournal(dataDir), new ActionJournal(dataDir)];
  let calls = 0;
  const operation = async () => {
    calls += 1;
    await Bun.sleep(15);
    return { ok: true };
  };
  const results = await Promise.allSettled(journals.map((journal) => journal.executeOnce({
    idempotency_key: "same", asset_id: "internal-bark", member_id: "qwen_intelligence",
    action: "push_notification", request: { body: "same" },
  }, operation, () => "accepted")));
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(calls).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});
