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
