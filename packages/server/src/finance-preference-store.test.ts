import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FinancePreferenceStore } from "./finance-preference-store";

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
