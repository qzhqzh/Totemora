import { createHash } from "node:crypto";

export const FORWARDED_STATUS_VALUES = ["pending", "completed", "failed", "uncertain", "deduped"] as const;
export type ForwardedStatus = typeof FORWARDED_STATUS_VALUES[number];

export interface ForwardedEventInput {
  source_id: string;
  source_message_id: string;
  occurred_at: string;
  title: string;
  body: string;
  priority: number;
  tags: string[];
  click_url?: string;
  image_url?: string;
}

export interface ForwardedEvent extends ForwardedEventInput {
  id: string;
  content_hash: string;
  status: ForwardedStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
  result?: unknown;
  last_error?: string;
  legacy_ref?: string;
}

export interface ForwardedSourceState {
  source_id: string;
  cursor_time: number;
  last_success_at?: string;
  last_error?: string;
  last_added: number;
  updated_at: string;
}

export function normalizeForwardedEvent(input: ForwardedEventInput): ForwardedEventInput & { content_hash: string } {
  const normalized: ForwardedEventInput = {
    source_id: stableKey(input.source_id, "Forwarded source_id", 64),
    source_message_id: safeText(input.source_message_id, "Forwarded source message id", 128, true),
    occurred_at: isoDate(input.occurred_at, "Forwarded occurred_at"),
    title: optionalText(input.title, "Forwarded title", 200),
    body: optionalText(input.body, "Forwarded body", 12_000),
    priority: integer(input.priority, "Forwarded priority", 1, 5),
    tags: tags(input.tags),
    ...(input.click_url ? { click_url: httpsUrl(input.click_url, "Forwarded click_url") } : {}),
    ...(input.image_url ? { image_url: httpsUrl(input.image_url, "Forwarded image_url") } : {}),
  };
  if (!normalized.title && !normalized.body) throw new Error("Forwarded event must contain a title or body");
  return { ...normalized, content_hash: forwardedContentHash(normalized) };
}

export function forwardedEventId(sourceId: string, sourceMessageId: string): string {
  const digest = createHash("sha256").update(`${sourceId}\0${sourceMessageId}`).digest("hex").slice(0, 32);
  return `forwarded-${digest}`;
}

export function forwardedDeliveryKey(event: Pick<ForwardedEventInput, "source_id" | "source_message_id">): string {
  return `forwarded:relay:${createHash("sha256")
    .update(`${event.source_id}\0${event.source_message_id}`).digest("hex").slice(0, 40)}`;
}

export function forwardedContentHash(event: ForwardedEventInput): string {
  return createHash("sha256").update(JSON.stringify({
    title: event.title,
    body: event.body,
    priority: event.priority,
    tags: [...event.tags].sort(),
    click_url: event.click_url ?? "",
    image_url: event.image_url ?? "",
  })).digest("hex");
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Forwarded tags must contain at most 20 values");
  return [...new Set(value.map((item) => safeText(item, "Forwarded tag", 64, true)))];
}
function optionalText(value: unknown, label: string, maximum: number): string {
  if (value === "" || value === undefined || value === null) return "";
  return safeText(value, label, maximum, false);
}
function safeText(value: unknown, label: string, maximum: number, singleLine: boolean): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new Error(`${label} must contain 1-${maximum} safe characters`);
  }
  if (singleLine && /[\r\n]/.test(text)) throw new Error(`${label} must be a single line`);
  return text;
}
function stableKey(value: unknown, label: string, maximum: number): string {
  const text = safeText(value, label, maximum, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`${label} must be a stable key`);
  return text;
}
function isoDate(value: unknown, label: string): string {
  const text = safeText(value, label, 100, true);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${label} must be ISO-8601`);
  return new Date(text).toISOString();
}
function httpsUrl(value: unknown, label: string): string {
  const text = safeText(value, label, 2_048, true);
  let url: URL;
  try { url = new URL(text); }
  catch { throw new Error(`${label} must be valid HTTPS`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${label} must be HTTPS without credentials`);
  return url.toString();
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be ${minimum}-${maximum}`);
  }
  return Number(value);
}
