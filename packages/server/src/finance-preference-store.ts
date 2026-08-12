import { StateDatabase } from "./state-database";

export type FinanceMarket = "CN" | "HK" | "US" | "JP" | "KR";

export interface FinanceWatchItem {
  market: FinanceMarket;
  symbol: string;
  name?: string;
}

export interface FinancePreferences {
  schema_version: 2;
  interests: string[];
  watchlist: FinanceWatchItem[];
  markets: FinanceMarket[];
  channels: {
    disclosures: boolean;
    regulation: boolean;
    macro: boolean;
    global_official: boolean;
    market_media: boolean;
  };
  scan_interval_minutes: number;
  push_interval_seconds: number;
  push_threshold: number;
  novelty_history_hours: number;
  morning_briefings: {
    timezone: "Asia/Shanghai";
    asia_preopen: { enabled: boolean; time: string };
    us_overnight: { enabled: boolean; time: string };
  };
  updated_at: string;
}

const DEFAULT_PREFERENCES: FinancePreferences = {
  schema_version: 2,
  interests: ["宏观政策", "资本市场监管", "上市公司重大事项", "人工智能与科技产业"],
  watchlist: [],
  markets: ["CN", "HK", "US", "JP", "KR"],
  channels: { disclosures: true, regulation: true, macro: true, global_official: true, market_media: true },
  scan_interval_minutes: 10,
  push_interval_seconds: 60,
  push_threshold: 0.78,
  novelty_history_hours: 168,
  morning_briefings: {
    timezone: "Asia/Shanghai",
    asia_preopen: { enabled: true, time: "07:00" },
    us_overnight: { enabled: true, time: "08:00" },
  },
  updated_at: new Date(0).toISOString(),
};

export class FinancePreferenceStore {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  async get(): Promise<FinancePreferences> {
    const stored = this.state.listRecords<FinancePreferences>("settings")
      .find((item) => "watchlist" in item && "markets" in item);
    const value = validate(stored ?? structuredClone(DEFAULT_PREFERENCES), stored?.schema_version !== 2);
    if (stored && stored.schema_version !== 2) {
      this.state.putRecord("settings", "finance_intelligence_preferences", value, value.updated_at, value.updated_at);
    }
    return value;
  }

  async save(input: unknown): Promise<FinancePreferences> {
    const value = validate(input);
    value.updated_at = new Date().toISOString();
    this.state.putRecord("settings", "finance_intelligence_preferences", value, value.updated_at, value.updated_at);
    return value;
  }
}

function validate(input: unknown, migrateLegacyMarkets = false): FinancePreferences {
  const value = input as Partial<FinancePreferences> | undefined;
  const interests = Array.isArray(value?.interests)
    ? value.interests.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 30)
    : DEFAULT_PREFERENCES.interests;
  if (interests.some((item) => item.length > 80)) throw new Error("Each finance interest must be at most 80 characters");
  const markets = [...new Set((Array.isArray(value?.markets) ? value.markets : DEFAULT_PREFERENCES.markets)
    .map(String).filter((market): market is FinanceMarket => ["CN", "HK", "US", "JP", "KR"].includes(market)))] as FinanceMarket[];
  if (migrateLegacyMarkets) {
    if (!markets.includes("JP")) markets.push("JP");
    if (!markets.includes("KR")) markets.push("KR");
  }
  if (!markets.length) throw new Error("At least one finance market is required");
  const watchlist = (Array.isArray(value?.watchlist) ? value.watchlist : []).flatMap((raw): FinanceWatchItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<FinanceWatchItem>;
    const market = String(item.market ?? "").toUpperCase();
    const symbol = String(item.symbol ?? "").trim().toUpperCase();
    const name = String(item.name ?? "").trim();
    if (!["CN", "HK", "US", "JP", "KR"].includes(market) || !/^[A-Z0-9._-]{1,20}$/.test(symbol)) return [];
    return [{ market: market as FinanceMarket, symbol, ...(name ? { name: name.slice(0, 80) } : {}) }];
  });
  const uniqueWatchlist = watchlist.filter((item, index, rows) =>
    rows.findIndex((other) => other.market === item.market && other.symbol === item.symbol) === index,
  ).slice(0, 100);
  const pushThreshold = Number(value?.push_threshold ?? DEFAULT_PREFERENCES.push_threshold);
  if (!Number.isFinite(pushThreshold) || pushThreshold < 0.6 || pushThreshold > 0.95) {
    throw new Error("push_threshold must be between 0.6 and 0.95");
  }
  const morningBriefings = value?.morning_briefings;
  return {
    schema_version: 2,
    interests,
    watchlist: uniqueWatchlist,
    markets,
    channels: {
      disclosures: value?.channels?.disclosures !== false,
      regulation: value?.channels?.regulation !== false,
      macro: value?.channels?.macro !== false,
      global_official: value?.channels?.global_official !== false,
      market_media: value?.channels?.market_media !== false,
    },
    scan_interval_minutes: boundedInteger(value?.scan_interval_minutes, 5, 60, DEFAULT_PREFERENCES.scan_interval_minutes, "scan_interval_minutes"),
    push_interval_seconds: boundedInteger(value?.push_interval_seconds, 60, 3_600, DEFAULT_PREFERENCES.push_interval_seconds, "push_interval_seconds"),
    push_threshold: pushThreshold,
    novelty_history_hours: boundedInteger(value?.novelty_history_hours, 24, 720, DEFAULT_PREFERENCES.novelty_history_hours, "novelty_history_hours"),
    morning_briefings: {
      timezone: "Asia/Shanghai",
      asia_preopen: {
        enabled: morningBriefings?.asia_preopen?.enabled !== false,
        time: validTime(morningBriefings?.asia_preopen?.time, DEFAULT_PREFERENCES.morning_briefings.asia_preopen.time, "asia_preopen.time"),
      },
      us_overnight: {
        enabled: morningBriefings?.us_overnight?.enabled !== false,
        time: validTime(morningBriefings?.us_overnight?.time, DEFAULT_PREFERENCES.morning_briefings.us_overnight.time, "us_overnight.time"),
      },
    },
    updated_at: typeof value?.updated_at === "string" ? value.updated_at : DEFAULT_PREFERENCES.updated_at,
  };
}

function validTime(value: unknown, fallback: string, name: string): string {
  const result = value === undefined ? fallback : String(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new Error(`${name} must use HH:MM`);
  return result;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number, name: string): number {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}
