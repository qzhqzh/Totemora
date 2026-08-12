import { StateDatabase } from "./state-database";
import type { FinanceSourceHealth, FinanceSourceItem } from "./finance-source-registry";

export type FinanceBriefingType = "asia_preopen" | "us_overnight";

export interface FinanceMarketMove {
  symbol: string;
  label: string;
  group: "us_benchmark" | "us_sector" | "asia_benchmark";
  close: number;
  previous_close: number;
  change_percent: number;
  as_of: string;
  url: string;
}

export interface FinanceMarketSnapshot {
  source: "Yahoo Finance chart";
  evidence_tier: "S3";
  captured_at: string;
  cached: boolean;
  completed_daily_bars: true;
  moves: FinanceMarketMove[];
}

const INSTRUMENTS = [
  ["^GSPC", "标普500", "us_benchmark"], ["^IXIC", "纳斯达克综指", "us_benchmark"],
  ["^DJI", "道琼斯", "us_benchmark"], ["^RUT", "罗素2000", "us_benchmark"],
  ["XLK", "科技", "us_sector"], ["XLF", "金融", "us_sector"],
  ["XLE", "能源", "us_sector"], ["XLV", "医疗", "us_sector"],
  ["XLI", "工业", "us_sector"], ["XLY", "可选消费", "us_sector"],
  ["XLP", "必选消费", "us_sector"], ["XLU", "公用事业", "us_sector"],
  ["XLC", "通信服务", "us_sector"], ["XLB", "材料", "us_sector"],
  ["XLRE", "房地产", "us_sector"], ["^N225", "日经225", "asia_benchmark"],
  ["^KS11", "韩国综合", "asia_benchmark"],
] as const;

const INSTRUMENT_BY_SYMBOL = new Map<string, { label: string; group: FinanceMarketMove["group"] }>(
  INSTRUMENTS.map(([symbol, label, group]) => [symbol, { label, group }]),
);
const ENDPOINTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

export class FinanceMarketSnapshotService {
  private readonly state: StateDatabase;

  constructor(dataDir: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.state = StateDatabase.open(dataDir);
  }

  async capture(): Promise<FinanceMarketSnapshot> {
    const started = Date.now();
    const errors: string[] = [];
    for (const origin of ENDPOINTS) {
      try {
        const url = new URL("/v7/finance/spark", origin);
        url.searchParams.set("symbols", INSTRUMENTS.map(([symbol]) => symbol).join(","));
        url.searchParams.set("range", "5d");
        url.searchParams.set("interval", "1d");
        const response = await this.fetchImpl(url, {
          headers: { "user-agent": "Totemora-Finance/0.12 (+https://github.com/qzhqzh/Totemora)" },
          signal: AbortSignal.timeout(20_000), redirect: "error",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await readLimitedResponse(response, 1_000_000);
        const snapshot = parseMarketSnapshotResponse(body, new Date().toISOString());
        this.state.putRecord("finance_market_snapshot_cache", "latest", snapshot, snapshot.captured_at, snapshot.captured_at);
        this.recordHealth("ready", snapshot.captured_at, Date.now() - started, snapshot.moves.length);
        return snapshot;
      } catch (error) {
        errors.push(`${new URL(origin).hostname}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const cached = this.state.listRecords<FinanceMarketSnapshot>("finance_market_snapshot_cache")
      .find((item) => item.moves?.length);
    this.recordHealth("degraded", new Date().toISOString(), Date.now() - started, cached?.moves.length, errors.join("; "));
    if (cached?.completed_daily_bars === true && Date.now() - Date.parse(cached.captured_at) <= 72 * 3_600_000) {
      return { ...cached, cached: true };
    }
    throw new Error(`结构化行情不可用：${errors.join("; ")}`);
  }

  private recordHealth(
    status: FinanceSourceHealth["status"], checkedAt: string, latencyMs: number,
    itemCount?: number, error?: string,
  ): void {
    const prior = this.state.listRecords<FinanceSourceHealth>("finance_source_health")
      .find((item) => item.id === "yahoo-finance-chart");
    const health: FinanceSourceHealth = {
      id: "yahoo-finance-chart", name: "Yahoo Finance 结构化行情", url: "https://finance.yahoo.com/markets/",
      tier: "S3", markets: ["US", "HK"], category: "market_data", availability: "active", official: false,
      summary: "晨报使用的指数与美国行业 ETF 日线快照；公开端点无服务承诺，失败时只复用 72 小时内缓存并显式标记。",
      status, last_checked_at: checkedAt,
      last_success_at: status === "ready" ? checkedAt : prior?.last_success_at,
      latency_ms: latencyMs, item_count: itemCount,
      ...(error ? { error: error.slice(0, 500) } : {}),
    };
    this.state.putRecord("finance_source_health", health.id, health, prior?.last_checked_at ?? checkedAt, checkedAt);
  }
}

export function parseMarketSnapshotResponse(body: string, capturedAt: string): FinanceMarketSnapshot {
  const root = JSON.parse(body) as { spark?: { result?: unknown[] } };
  const rows = Array.isArray(root.spark?.result) ? root.spark.result : [];
  const moves = rows.flatMap((raw): FinanceMarketMove[] => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as { symbol?: unknown; response?: unknown[] };
    const symbol = String(row.symbol ?? "");
    const instrument = INSTRUMENT_BY_SYMBOL.get(symbol);
    const response = Array.isArray(row.response) && row.response[0] && typeof row.response[0] === "object"
      ? row.response[0] as {
        timestamp?: unknown[];
        indicators?: { quote?: Array<{ close?: unknown[] }> };
        meta?: { currentTradingPeriod?: { regular?: { start?: unknown; end?: unknown } } };
      }
      : undefined;
    const timestamps = response?.timestamp;
    const closes = response?.indicators?.quote?.[0]?.close;
    if (!instrument || !Array.isArray(timestamps) || !Array.isArray(closes)) return [];
    let observations = closes.flatMap((value, index) => {
      const close = Number(value);
      const timestamp = Number(timestamps[index]);
      return Number.isFinite(close) && close > 0 && Number.isFinite(timestamp) && timestamp > 0 ? [{ close, timestamp }] : [];
    });
    const regular = response?.meta?.currentTradingPeriod?.regular;
    const regularStart = Number(regular?.start);
    const regularEnd = Number(regular?.end);
    const capturedEpoch = Date.parse(capturedAt) / 1_000;
    if (Number.isFinite(capturedEpoch) && Number.isFinite(regularStart) && Number.isFinite(regularEnd)
      && capturedEpoch >= regularStart && capturedEpoch < regularEnd
      && observations.at(-1)?.timestamp === regularStart) {
      observations = observations.slice(0, -1);
    }
    const current = observations.at(-1);
    const previous = observations.at(-2);
    if (!current || !previous) return [];
    return [{
      symbol, label: instrument.label, group: instrument.group,
      close: current.close, previous_close: previous.close,
      change_percent: ((current.close / previous.close) - 1) * 100,
      as_of: new Date(current.timestamp * 1_000).toISOString(),
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
    }];
  });
  const benchmarkCount = moves.filter((move) => move.group === "us_benchmark").length;
  const sectorCount = moves.filter((move) => move.group === "us_sector").length;
  if (benchmarkCount < 2 || sectorCount < 5) throw new Error("结构化行情返回不完整");
  return {
    source: "Yahoo Finance chart", evidence_tier: "S3", captured_at: capturedAt,
    cached: false, completed_daily_bars: true, moves,
  };
}

export function formatMorningSnapshot(
  snapshot: FinanceMarketSnapshot,
  type: FinanceBriefingType,
  sources: FinanceSourceItem[],
): string {
  const us = snapshot.moves.filter((move) => move.group === "us_benchmark");
  const sectors = snapshot.moves.filter((move) => move.group === "us_sector")
    .sort((left, right) => right.change_percent - left.change_percent);
  const asia = snapshot.moves.filter((move) => move.group === "asia_benchmark");
  const lines = type === "asia_preopen"
    ? [
      "日韩现货 08:00（北京时间）开盘，当前为盘前。",
      `隔夜美股：${us.slice(0, 4).map(formatMove).join("｜")}`,
      asia.length ? `日韩上日：${asia.map(formatMove).join("｜")}` : "",
    ]
    : [`美股收盘：${us.slice(0, 4).map(formatMove).join("｜")}`];
  if (sectors.length >= 4) {
    lines.push(`板块领涨：${sectors.slice(0, 2).map(formatMove).join("｜")}；领跌：${sectors.slice(-2).reverse().map(formatMove).join("｜")}`);
  }
  const hotMoves = sources.filter((source) => source.source_id.startsWith("xueqiu-hot-stock:")
      && source.market === "US" && Math.abs(source.change_percent ?? 0) >= 5)
    .sort((left, right) => Math.abs(right.change_percent ?? 0) - Math.abs(left.change_percent ?? 0))
    .slice(0, 3);
  if (hotMoves.length) {
    lines.push(`热股异动（S4线索）：${hotMoves.map((item) => `${item.symbols[0] ?? item.title} ${signed(item.change_percent!)}`).join("｜")}`);
  }
  if (snapshot.cached) lines.push(`行情使用 ${snapshot.captured_at.slice(0, 16).replace("T", " ")} 缓存，需留意时效。`);
  return lines.filter(Boolean).join("\n");
}

function formatMove(move: FinanceMarketMove): string {
  return `${move.label} ${signed(move.change_percent)}`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

async function readLimitedResponse(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error(`response exceeded ${limit} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`response exceeded ${limit} bytes`);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
