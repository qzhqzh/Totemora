export const NOTIFICATION_DOMAINS = [
  "ai",
  "finance",
  "reminder",
  "deals",
  "forwarded",
  "content",
  "ops",
] as const;

export const NOTIFICATION_CHANNELS = ["bark", "telegram", "ntfy"] as const;

export const NOTIFICATION_KINDS = [
  "immediate",
  "digest",
  "reminder",
  "relay",
  "draft",
  "status",
] as const;

export type NotificationDomain = typeof NOTIFICATION_DOMAINS[number];
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

export interface NotificationSource {
  source_id: string;
  url?: string;
  occurred_at?: string;
}

export interface NotificationEnvelopeV1 {
  schema_version: 1;
  id: string;
  idempotency_key: string;
  domain: NotificationDomain;
  kind: NotificationKind;
  title: string;
  body: string;
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  source?: NotificationSource;
  click_url?: string;
  image_url?: string;
  target_channels?: NotificationChannel[];
}

export class NotificationEnvelopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationEnvelopeValidationError";
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const STABLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export function parseNotificationEnvelope(input: unknown): NotificationEnvelopeV1 {
  const value = objectValue(input, "notification envelope");
  if (value.schema_version !== 1) fail("schema_version must be 1");
  const domain = enumValue(value.domain, NOTIFICATION_DOMAINS, "domain");
  const kind = enumValue(value.kind, NOTIFICATION_KINDS, "kind");
  const priority = integerValue(value.priority, 1, 5, "priority") as NotificationEnvelopeV1["priority"];
  const source = value.source === undefined ? undefined : parseSource(value.source);
  const targetChannels = value.target_channels === undefined
    ? undefined
    : uniqueArray(value.target_channels, NOTIFICATION_CHANNELS, "target_channels", 3);
  return {
    schema_version: 1,
    id: stableKey(value.id, "id", 200),
    idempotency_key: stableKey(value.idempotency_key, "idempotency_key", 256),
    domain,
    kind,
    title: textValue(value.title, "title", 200, true),
    body: textValue(value.body, "body", 12_000),
    priority,
    tags: tagArray(value.tags),
    ...(source ? { source } : {}),
    ...(value.click_url === undefined ? {} : { click_url: httpsUrl(value.click_url, "click_url") }),
    ...(value.image_url === undefined ? {} : { image_url: httpsUrl(value.image_url, "image_url") }),
    ...(targetChannels ? { target_channels: targetChannels } : {}),
  };
}

function parseSource(input: unknown): NotificationSource {
  const value = objectValue(input, "source");
  const occurredAt = value.occurred_at === undefined
    ? undefined
    : isoDate(value.occurred_at, "source.occurred_at");
  return {
    source_id: textValue(value.source_id, "source.source_id", 256, true),
    ...(value.url === undefined ? {} : { url: httpsUrl(value.url, "source.url") }),
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
  };
}

function objectValue(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function textValue(input: unknown, label: string, maximum: number, singleLine = false): string {
  if (typeof input !== "string") fail(`${label} must be a string`);
  const value = input.trim();
  if (!value || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    fail(`${label} must contain 1-${maximum} safe characters`);
  }
  if (singleLine && /[\r\n]/.test(value)) fail(`${label} must be a single line`);
  return value;
}

function stableKey(input: unknown, label: string, maximum: number): string {
  const value = textValue(input, label, maximum, true);
  if (!STABLE_KEY.test(value)) fail(`${label} must be a stable ASCII key`);
  return value;
}

function integerValue(input: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(input) || Number(input) < minimum || Number(input) > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(input);
}

function enumValue<const T extends readonly string[]>(input: unknown, values: T, label: string): T[number] {
  if (typeof input !== "string" || !values.includes(input as T[number])) {
    fail(`${label} must be one of ${values.join(", ")}`);
  }
  return input as T[number];
}

function uniqueArray<const T extends readonly string[]>(
  input: unknown,
  allowed: T,
  label: string,
  maximum: number,
): T[number][] {
  if (!Array.isArray(input)) fail(`${label} must be an array`);
  const unique = [...new Set(input.map((item) => enumValue(item, allowed, label)))];
  if (unique.length > maximum) fail(`${label} must contain at most ${maximum} values`);
  return unique;
}

function tagArray(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 20) fail("tags must contain at most 20 values");
  return [...new Set(input.map((item) => textValue(item, "tag", 64, true)))];
}

function httpsUrl(input: unknown, label: string): string {
  const value = textValue(input, label, 2_048, true);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { return fail(`${label} must be a valid HTTPS URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail(`${label} must be an HTTPS URL without embedded credentials`);
  }
  return parsed.toString();
}

function isoDate(input: unknown, label: string): string {
  const value = textValue(input, label, 100, true);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) fail(`${label} must be a valid ISO-8601 timestamp`);
  return new Date(timestamp).toISOString();
}

function fail(message: string): never {
  throw new NotificationEnvelopeValidationError(message);
}
