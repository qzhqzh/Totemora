import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IntelligencePreferenceStore } from "./intelligence-preference-store";

test("intelligence preferences enable AI HOT by default and persist optional channels", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-preferences-"));
  const store = new IntelligencePreferenceStore(dataDir);
  expect(await store.get()).toMatchObject({ channels: { rss: true, ai_hot: true, x_trends: false, weibo_hot: false }, scan_interval_minutes: 10, push_interval_seconds: 60, push_threshold: 0.72 });
  const saved = await store.save({ interests: ["AI", "生物信息"], channels: { rss: true, ai_hot: false, x_trends: true, weibo_hot: true }, x_woeid: 1 });
  expect(saved.interests).toEqual(["AI", "生物信息"]);
  expect((await store.get()).channels.x_trends).toBe(true);
  expect((await store.get()).channels.ai_hot).toBe(false);
  await rm(dataDir, { recursive: true, force: true });
});
