import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FinancePreferenceStore } from "./finance-preference-store";
import { StateDatabase } from "./state-database";

test("finance preferences normalize markets and watchlist without mixing AI settings", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-preferences-"));
  const store = new FinancePreferenceStore(dataDir);
  const saved = await store.save({
    interests: ["半导体", "货币政策"], markets: ["CN", "US", "CN"],
    watchlist: [
      { market: "cn", symbol: "600519", name: "贵州茅台" },
      { market: "CN", symbol: "600519" },
      { market: "US", symbol: "nvda" },
      { market: "invalid", symbol: "bad" },
    ],
    channels: { disclosures: true, regulation: true, macro: false, global_official: true, market_media: false },
  });
  expect(saved.markets).toEqual(["CN", "US"]);
  expect(saved.watchlist).toEqual([
    { market: "CN", symbol: "600519", name: "贵州茅台" },
    { market: "US", symbol: "NVDA" },
  ]);
  expect(saved.channels.market_media).toBe(false);
  expect(saved.morning_briefings).toEqual({
    timezone: "Asia/Shanghai",
    asia_preopen: { enabled: true, time: "07:00" },
    us_overnight: { enabled: true, time: "08:00" },
  });
  expect((await store.get()).interests).toEqual(["半导体", "货币政策"]);
  await rm(dataDir, { recursive: true, force: true });
});

test("finance morning briefing preferences validate times and remain backward compatible", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-briefing-preferences-"));
  const store = new FinancePreferenceStore(dataDir);
  const saved = await store.save({
    markets: ["US"],
    morning_briefings: {
      timezone: "Asia/Shanghai",
      asia_preopen: { enabled: false, time: "06:45" },
      us_overnight: { enabled: true, time: "08:15" },
    },
  });
  expect(saved.morning_briefings.asia_preopen).toEqual({ enabled: false, time: "06:45" });
  expect(saved.morning_briefings.us_overnight).toEqual({ enabled: true, time: "08:15" });
  expect(store.save({ markets: ["US"], morning_briefings: { us_overnight: { time: "25:00" } } })).rejects.toThrow("HH:MM");
  await rm(dataDir, { recursive: true, force: true });
});

test("legacy finance preferences gain JP and KR once without overriding later choices", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-preferences-migration-"));
  const createdAt = "2026-08-01T00:00:00.000Z";
  StateDatabase.open(dataDir).putRecord("settings", "finance_intelligence_preferences", {
    interests: ["宏观"], watchlist: [], markets: ["CN", "HK", "US"],
    channels: { disclosures: true, regulation: true, macro: true, global_official: true, market_media: false },
    scan_interval_minutes: 10, push_interval_seconds: 60, push_threshold: 0.78,
    novelty_history_hours: 168, updated_at: createdAt,
  }, createdAt, createdAt);
  const store = new FinancePreferenceStore(dataDir);
  expect((await store.get()).markets).toEqual(["CN", "HK", "US", "JP", "KR"]);
  expect((await store.save({ markets: ["US"] })).markets).toEqual(["US"]);
  expect((await store.get()).markets).toEqual(["US"]);
  await rm(dataDir, { recursive: true, force: true });
});
