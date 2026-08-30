import { createHash } from "node:crypto";

export const DEAL_STATUS_VALUES = ["pending", "delivered", "uncertain", "skipped"] as const;
export const DEAL_WINDOW_STATUS_VALUES = ["pending", "completed", "failed", "uncertain", "skipped_empty"] as const;

export type DealStatus = typeof DEAL_STATUS_VALUES[number];
export type DealWindowStatus = typeof DEAL_WINDOW_STATUS_VALUES[number];

export interface CollectedDeal {
  source_id: string;
  title: string;
  deal_text: string;
  merchant: string;
  source_url: string;
  image_url?: string;
  source_rank: number;
}

export interface DealItem extends CollectedDeal {
  id: string;
  status: DealStatus;
  discovered_at: string;
  updated_at: string;
  terminal_at?: string;
  legacy_ref?: string;
}

export interface DealDeliveryWindow {
  window_key: string;
  local_hour: string;
  status: DealWindowStatus;
  item_count: number;
  attempts: number;
  created_at: string;
  updated_at: string;
  result?: unknown;
  last_error?: string;
}

export interface DealSourceRun {
  id: string;
  status: "success" | "error";
  started_at: string;
  finished_at: string;
  fetched_count: number;
  inserted_count: number;
  selected_count: number;
  error?: string;
}

export function dealId(sourceId: unknown): string {
  const source = safeText(sourceId, "Deal source_id", 256, true);
  return `deal-${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

export function dealWindowKey(localHour: unknown): string {
  const value = assertLocalHour(localHour);
  return `deals:digest:${value.slice(0, 10)}:${value.slice(11)}`;
}

export function shanghaiHour(now = new Date()): { local_hour: string; hour: number; now_iso: string } {
  if (Number.isNaN(now.getTime())) throw new Error("Deals clock must be a valid date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const hour = Number(part("hour"));
  return { local_hour: `${date}T${String(hour).padStart(2, "0")}`, hour, now_iso: now.toISOString() };
}

export function normalizeCollectedDeal(input: CollectedDeal): CollectedDeal {
  return {
    source_id: safeText(input.source_id, "Deal source_id", 256, true),
    title: safeText(input.title, "Deal title", 240, true),
    deal_text: optionalText(input.deal_text, "Deal text", 200),
    merchant: optionalText(input.merchant, "Deal merchant", 120),
    source_url: httpsUrl(input.source_url, "Deal source_url"),
    ...(input.image_url ? { image_url: httpsUrl(input.image_url, "Deal image_url") } : {}),
    source_rank: boundedInteger(input.source_rank, "Deal source_rank", 1, 1_000),
  };
}

export function assertLocalHour(input: unknown): string {
  const value = safeText(input, "Deal local_hour", 13, true);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])$/.test(value)) {
    throw new Error("Deal local_hour must use YYYY-MM-DDTHH");
  }
  const parsed = Date.parse(`${value}:00:00+08:00`);
  if (Number.isNaN(parsed) || shanghaiHour(new Date(parsed)).local_hour !== value) {
    throw new Error("Deal local_hour is not a real date and hour");
  }
  return value;
}

export function formatDealDigest(items: DealItem[]): string {
  if (!items.length || items.length > 5) throw new Error("Deal digest must contain 1-5 items");
  const blocks: string[] = [];
  for (const [index, item] of items.entries()) {
    const merchant = item.merchant.split("|")[0]?.trim() || "优惠精选";
    const block = `${index + 1}. 【推好物·${merchant}】${item.title}\n💰 ${item.deal_text || "查看详情"}\n${item.source_url}`;
    if (Buffer.byteLength([...blocks, block].join("\n\n"), "utf8") > 11_500) break;
    blocks.push(block);
  }
  if (!blocks.length) throw new Error("Deal digest first item exceeds the notification body limit");
  if (blocks.length < items.length) blocks.push(`… 还有 ${items.length - blocks.length} 条请在 Totemora 中查看。`);
  return blocks.join("\n\n");
}

function optionalText(input: unknown, label: string, maximum: number): string {
  if (input === "" || input === undefined || input === null) return "";
  return safeText(input, label, maximum, true);
}

function safeText(input: unknown, label: string, maximum: number, singleLine = false): string {
  if (typeof input !== "string") throw new Error(`${label} must be a string`);
  const value = input.trim();
  if (!value || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new Error(`${label} must contain 1-${maximum} safe characters`);
  }
  if (singleLine && /[\r\n]/.test(value)) throw new Error(`${label} must be a single line`);
  return value;
}

function httpsUrl(input: unknown, label: string): string {
  const value = safeText(input, label, 2_048, true);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} must be a valid HTTPS URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be an HTTPS URL without credentials`);
  }
  return parsed.toString();
}

function boundedInteger(input: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(input) || Number(input) < minimum || Number(input) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(input);
}
