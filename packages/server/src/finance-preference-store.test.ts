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
    channels: { disclosures: true, regulation: true, macro: false, global_official: true },
  });
  expect(saved.markets).toEqual(["CN", "US"]);
  expect(saved.watchlist).toEqual([
    { market: "CN", symbol: "600519", name: "贵州茅台" },
    { market: "US", symbol: "NVDA" },
  ]);
  expect((await store.get()).interests).toEqual(["半导体", "货币政策"]);
  await rm(dataDir, { recursive: true, force: true });
});
