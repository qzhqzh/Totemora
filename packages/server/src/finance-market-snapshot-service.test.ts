import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FinanceMarketSnapshotService,
  formatMorningSnapshot,
  parseMarketSnapshotResponse,
} from "./finance-market-snapshot-service";

function payload() {
  const symbols = ["^GSPC", "^IXIC", "^DJI", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "^N225", "^KS11"];
  return JSON.stringify({ spark: { result: symbols.map((symbol, index) => ({
    symbol,
    response: [{ timestamp: [1_700_000_000, 1_700_086_400], indicators: { quote: [{ close: [100, 100 + index] }] } }],
  })) } });
}

test("market snapshot parses deterministic benchmark and sector moves", () => {
  const snapshot = parseMarketSnapshotResponse(payload(), "2026-08-12T00:00:00.000Z");
  expect(snapshot.moves.find((move) => move.symbol === "^IXIC")?.change_percent).toBeCloseTo(1);
  expect(snapshot.moves.find((move) => move.symbol === "XLK")?.group).toBe("us_sector");
  const text = formatMorningSnapshot(snapshot, "asia_preopen", [{
    title: "雪球热股：Example", link: "https://xueqiu.com/S/EXM", source: "雪球热股",
    source_id: "xueqiu-hot-stock:EXM", source_url: "https://xueqiu.com/hot/stock",
    evidence_tier: "S4", market: "US", symbols: ["EXM"], event_type: "market_attention", change_percent: -8.2,
  }]);
  expect(text).toContain("当前为盘前");
  expect(text).toContain("板块领涨");
  expect(text).toContain("EXM -8.20%");
});

test("market snapshot excludes the unfinished daily bar during a live US session", () => {
  const symbols = ["^GSPC", "^IXIC", "^DJI", "XLK", "XLF", "XLE", "XLV", "XLI"];
  const body = JSON.stringify({ spark: { result: symbols.map((symbol) => ({
    symbol,
    response: [{
      meta: { currentTradingPeriod: { regular: { start: 1_700_172_800, end: 1_700_196_200 } } },
      timestamp: [1_700_000_000, 1_700_086_400, 1_700_172_800],
      indicators: { quote: [{ close: [100, 110, 121] }] },
    }],
  })) } });
  const snapshot = parseMarketSnapshotResponse(body, new Date(1_700_180_000 * 1_000).toISOString());
  expect(snapshot.moves[0]).toMatchObject({ close: 110, previous_close: 100 });
  expect(snapshot.moves[0]?.change_percent).toBeCloseTo(10);
});

test("market snapshot falls back to a recent cache", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-market-snapshot-"));
  let online = true;
  const fetchImpl = async () => online ? new Response(payload()) : Promise.reject(new Error("offline"));
  const service = new FinanceMarketSnapshotService(dataDir, fetchImpl as unknown as typeof fetch);
  expect((await service.capture()).cached).toBe(false);
  online = false;
  expect((await service.capture()).cached).toBe(true);
  await rm(dataDir, { recursive: true, force: true });
});
