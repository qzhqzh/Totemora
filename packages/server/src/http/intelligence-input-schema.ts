import type { FinanceBriefingType } from "../finance-market-snapshot-service";
import type { FinanceMarket, FinanceWatchItem } from "../finance-preference-store";
import type { TelegramUpdate } from "../telegram-bot-service";
import { HttpError } from "./http-boundary";
import {
  inputObject,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requiredString,
} from "./input-schema";

const DELIVERY_MODES = ["candidate_pool", "direct_push"] as const;
const BRIEFING_TYPES = ["asia_preopen", "us_overnight"] as const;
const FINANCE_MARKETS = ["CN", "HK", "US", "JP", "KR"] as const;

export interface IntelligenceTaskRouteInput {
  message_count?: number;
  idempotency_key?: string;
  delivery_mode?: "candidate_pool" | "direct_push";
  briefing_type?: FinanceBriefingType;
}

export interface ManualIntelligenceRunInput {
  message_count?: number;
  idempotency_key?: string;
  briefing_type?: FinanceBriefingType;
}

export interface IntelligencePreferencesInput {
  interests?: string[];
  channels?: { rss?: boolean; ai_hot?: boolean; x_trends?: boolean; weibo_hot?: boolean };
  x_woeid?: number;
  scan_interval_minutes?: number;
  push_interval_seconds?: number;
  push_threshold?: number;
  novelty_history_hours?: number;
}

export interface FinancePreferencesInput {
  interests?: string[];
  watchlist?: FinanceWatchItem[];
  markets?: FinanceMarket[];
  channels?: {
    disclosures?: boolean; regulation?: boolean; macro?: boolean;
    global_official?: boolean; market_media?: boolean;
  };
  scan_interval_minutes?: number;
  push_interval_seconds?: number;
  push_threshold?: number;
  novelty_history_hours?: number;
  morning_briefings?: {
    timezone?: "Asia/Shanghai";
    asia_preopen?: { enabled?: boolean; time?: string };
    us_overnight?: { enabled?: boolean; time?: string };
  };
}

export function intelligenceTaskInput(value: unknown): IntelligenceTaskRouteInput {
  return baseTaskInput(value, false);
}

export function financeTaskInput(value: unknown): IntelligenceTaskRouteInput {
  return baseTaskInput(value, true);
}

export function manualIntelligenceRunInput(value: unknown): ManualIntelligenceRunInput {
  return baseRunInput(value, false);
}

export function manualFinanceRunInput(value: unknown): ManualIntelligenceRunInput {
  return baseRunInput(value, true);
}

export function intelligencePreferencesInput(value: unknown): IntelligencePreferencesInput {
  const input = inputObject(value);
  const channels = optionalObject(input.channels, "channels");
  return {
    interests: optionalStringArray(input.interests, "interests", 20, 80),
    channels: channels ? {
      rss: optionalBoolean(channels.rss, "channels.rss"),
      ai_hot: optionalBoolean(channels.ai_hot, "channels.ai_hot"),
      x_trends: optionalBoolean(channels.x_trends, "channels.x_trends"),
      weibo_hot: optionalBoolean(channels.weibo_hot, "channels.weibo_hot"),
    } : undefined,
    x_woeid: optionalNumber(input.x_woeid, "x_woeid", { minimum: 1, maximum: Number.MAX_SAFE_INTEGER, integer: true }),
    scan_interval_minutes: optionalNumber(input.scan_interval_minutes, "scan_interval_minutes", { minimum: 5, maximum: 60, integer: true }),
    push_interval_seconds: optionalNumber(input.push_interval_seconds, "push_interval_seconds", { minimum: 60, maximum: 3_600, integer: true }),
    push_threshold: optionalNumber(input.push_threshold, "push_threshold", { minimum: 0.5, maximum: 0.95 }),
    novelty_history_hours: optionalNumber(input.novelty_history_hours, "novelty_history_hours", { minimum: 6, maximum: 720, integer: true }),
  };
}

export function financePreferencesInput(value: unknown): FinancePreferencesInput {
  const input = inputObject(value);
  const channels = optionalObject(input.channels, "channels");
  const markets = optionalStringArray(input.markets, "markets", 5, 2);
  if (markets && (!markets.length || markets.some((market) => !FINANCE_MARKETS.includes(market as FinanceMarket)))) {
    throw new HttpError(400, `markets must contain one or more of ${FINANCE_MARKETS.join(", ")}`);
  }
  return {
    interests: optionalStringArray(input.interests, "interests", 30, 80),
    watchlist: financeWatchlist(input.watchlist),
    markets: markets as FinanceMarket[] | undefined,
    channels: channels ? {
      disclosures: optionalBoolean(channels.disclosures, "channels.disclosures"),
      regulation: optionalBoolean(channels.regulation, "channels.regulation"),
      macro: optionalBoolean(channels.macro, "channels.macro"),
      global_official: optionalBoolean(channels.global_official, "channels.global_official"),
      market_media: optionalBoolean(channels.market_media, "channels.market_media"),
    } : undefined,
    scan_interval_minutes: optionalNumber(input.scan_interval_minutes, "scan_interval_minutes", { minimum: 5, maximum: 60, integer: true }),
    push_interval_seconds: optionalNumber(input.push_interval_seconds, "push_interval_seconds", { minimum: 60, maximum: 3_600, integer: true }),
    push_threshold: optionalNumber(input.push_threshold, "push_threshold", { minimum: 0.6, maximum: 0.95 }),
    novelty_history_hours: optionalNumber(input.novelty_history_hours, "novelty_history_hours", { minimum: 24, maximum: 720, integer: true }),
    morning_briefings: morningBriefings(input.morning_briefings),
  };
}

export function telegramUpdateInput(value: unknown): TelegramUpdate {
  const input = inputObject(value, "Telegram update");
  requiredSafeInteger(input.update_id, "update_id", 0);
  if (input.message !== undefined) validateTelegramMessage(input.message, "message");
  if (input.callback_query !== undefined) {
    const callback = inputObject(input.callback_query, "callback_query");
    requiredString(callback.id, "callback_query.id", 256);
    optionalString(callback.data, "callback_query.data", 256);
    if (callback.message !== undefined) validateTelegramMessage(callback.message, "callback_query.message");
  }
  return input as unknown as TelegramUpdate;
}

function baseTaskInput(value: unknown, finance: boolean): IntelligenceTaskRouteInput {
  const input = inputObject(value);
  return {
    ...baseRunInput(input, finance),
    delivery_mode: optionalEnum(input.delivery_mode, "delivery_mode", DELIVERY_MODES),
  };
}

function baseRunInput(value: unknown, finance: boolean): ManualIntelligenceRunInput {
  const input = inputObject(value);
  return {
    message_count: optionalNumber(input.message_count, "message_count", { minimum: 1, maximum: 5, integer: true }),
    idempotency_key: optionalString(input.idempotency_key, "idempotency_key", 256),
    ...(finance ? {
      briefing_type: optionalEnum(input.briefing_type, "briefing_type", BRIEFING_TYPES),
    } : {}),
  };
}

function financeWatchlist(value: unknown): FinanceWatchItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "watchlist must contain at most 100 entries");
  }
  return value.map((raw, index) => {
    const item = inputObject(raw, `watchlist[${index}]`);
    const marketValue = requiredString(item.market, `watchlist[${index}].market`, 2).toUpperCase();
    if (!FINANCE_MARKETS.includes(marketValue as FinanceMarket)) {
      throw new HttpError(400, `watchlist[${index}].market must be one of ${FINANCE_MARKETS.join(", ")}`);
    }
    const market = marketValue as FinanceMarket;
    const symbol = requiredString(item.symbol, `watchlist[${index}].symbol`, 20).toUpperCase();
    if (!/^[A-Z0-9._-]+$/.test(symbol)) {
      throw new HttpError(400, `watchlist[${index}].symbol has an invalid format`);
    }
    const name = optionalString(item.name, `watchlist[${index}].name`, 80);
    return { market, symbol, ...(name ? { name } : {}) };
  });
}

function morningBriefings(value: unknown): FinancePreferencesInput["morning_briefings"] {
  const input = optionalObject(value, "morning_briefings");
  if (!input) return undefined;
  return {
    timezone: optionalEnum(input.timezone, "morning_briefings.timezone", ["Asia/Shanghai"] as const),
    asia_preopen: briefingWindow(input.asia_preopen, "morning_briefings.asia_preopen"),
    us_overnight: briefingWindow(input.us_overnight, "morning_briefings.us_overnight"),
  };
}

function briefingWindow(value: unknown, label: string): { enabled?: boolean; time?: string } | undefined {
  const input = optionalObject(value, label);
  if (!input) return undefined;
  const time = optionalString(input.time, `${label}.time`, 5);
  if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new HttpError(400, `${label}.time must use HH:MM`);
  }
  return { enabled: optionalBoolean(input.enabled, `${label}.enabled`), time };
}

function optionalObject(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : inputObject(value, label);
}

function validateTelegramMessage(value: unknown, label: string): void {
  const message = inputObject(value, label);
  requiredSafeInteger(message.message_id, `${label}.message_id`, 0);
  optionalString(message.text, `${label}.text`, 4_096);
  const chat = inputObject(message.chat, `${label}.chat`);
  requiredSafeInteger(chat.id, `${label}.chat.id`);
  requiredString(chat.type, `${label}.chat.type`, 40);
}

function requiredSafeInteger(value: unknown, label: string, minimum?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new HttpError(400, `${label} must be a safe integer`);
  }
  return value;
}
