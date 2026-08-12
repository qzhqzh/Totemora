import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FinanceMarketSnapshotService,
  formatMorningSnapshot,
  parseMarketSnapshotResponse,
  usMarketSession,
} from "./finance-market-snapshot-service";

function payload(latest = 1_700_086_400) {
  const symbols = ["^GSPC", "^IXIC", "^DJI", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "^N225", "^KS11"];
  return JSON.stringify({ spark: { result: symbols.map((symbol, index) => ({
    symbol,
    response: [{ timestamp: [latest - 86_400, latest], indicators: { quote: [{ close: [100, 100 + index] }] } }],
  })) } });
}

test("market snapshot parses deterministic benchmark and sector moves", () => {
  const latest = Date.parse("2026-08-11T13:30:00.000Z") / 1_000;
  const snapshot = parseMarketSnapshotResponse(payload(latest), "2026-08-12T00:00:00.000Z");
  expect(snapshot.moves.find((move) => move.symbol === "^IXIC")?.change_percent).toBeCloseTo(1);
  expect(snapshot.moves.find((move) => move.symbol === "XLK")?.group).toBe("us_sector");
  const text = formatMorningSnapshot(snapshot, "asia_preopen", [{
    title: "雪球热股：Example", link: "https://xueqiu.com/S/EXM", source: "雪球热股",
    source_id: "xueqiu-hot-stock:EXM", source_url: "https://xueqiu.com/hot/stock",
    evidence_tier: "S4", market: "US", symbols: ["EXM"], event_type: "market_attention", change_percent: -8.2,
  }, {
    title: "Bank of Japan releases Monetary Policy Meeting materials", link: "https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm",
    source: "日本银行", source_id: "boj-whats-new:policy", source_url: "https://www.boj.or.jp/en/rss/whatsnew.xml",
    evidence_tier: "S1", market: "JP", symbols: [], event_type: "monetary_policy",
  }]);
  expect(text).toContain("当前为盘前");
  expect(text).toContain("板块领涨");
  expect(text).toContain("EXM -8.20%");
  expect(text).toContain("[S1 日本银行] Bank of Japan releases Monetary Policy Meeting materials");
  expect(usMarketSession(snapshot)).toEqual({ fresh: true, date: "2026-08-11" });
});

test("market snapshot labels a holiday gap as no new US close", () => {
  const friday = Date.parse("2026-09-04T13:30:00.000Z") / 1_000;
  const snapshot = parseMarketSnapshotResponse(payload(friday), "2026-09-08T00:05:00.000Z");
  const text = formatMorningSnapshot(snapshot, "us_overnight", [{
    title: "Issuer files material event disclosure", link: "https://www.sec.gov/Archives/edgar/data/example",
    source: "SEC EDGAR", source_id: "sec-current-filings:event", source_url: "https://www.sec.gov/cgi-bin/browse-edgar",
    evidence_tier: "S0", market: "US", symbols: ["EXM"], event_type: "material_event",
  }]);
  expect(usMarketSession(snapshot)).toEqual({ fresh: false, date: "2026-09-04" });
  expect(text).toContain("美股无新收盘（最近交易日 2026-09-04）");
  expect(text).toContain("[S0 SEC EDGAR] Issuer files material event disclosure");
  expect(text).not.toContain("隔夜美股");
});

test("market snapshot uses the current cache check time for session freshness", () => {
  const friday = Date.parse("2026-09-04T13:30:00.000Z") / 1_000;
  const snapshot = parseMarketSnapshotResponse(payload(friday), "2026-09-05T00:05:00.000Z");
  expect(usMarketSession(snapshot).fresh).toBe(true);
  expect(usMarketSession({ ...snapshot, cached: true, checked_at: "2026-09-08T00:05:00.000Z" })).toEqual({
    fresh: false, date: "2026-09-04",
  });
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
