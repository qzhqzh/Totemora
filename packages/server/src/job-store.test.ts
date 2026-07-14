import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./job-store";

test("persists jobs and retry input across store instances", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-job-store-"));
  await new JobStore<{ id: string; status: string }, { goal: string }>(dataDir)
    .save({ id: "job-1", status: "failed" }, { goal: "分析项目" });
  expect(await new JobStore<{ id: string; status: string }, { goal: string }>(dataDir).list()).toEqual([
    { job: { id: "job-1", status: "failed" }, input: { goal: "分析项目" } },
  ]);
  await rm(dataDir, { recursive: true, force: true });
});
