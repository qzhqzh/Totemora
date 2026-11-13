const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const TYPE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class ExternalNotificationInputError extends Error {}

export interface ExternalNotificationEvent {
  schema_version: 1;
  source: string;
  id: string;
  type: string;
  title: string;
  body: string;
  priority: 1 | 2 | 3 | 4 | 5;
  occurred_at?: string;
  dedupe_key?: string;
}

export function readExternalEventSource(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ExternalNotificationInputError("Event must be an object");
  const source = (input as Record<string, unknown>).source;
  if (typeof source !== "string" || source.length < 1 || source.length > 64 || !KEY.test(source)) {
    throw new ExternalNotificationInputError("source must be a stable key");
  }
  return source;
}

export function parseExternalNotificationEvent(input: unknown): ExternalNotificationEvent {
  const value = input as Record<string, unknown>;
  const source = readExternalEventSource(input);
  if (Object.keys(value).some((key) => ![
    "schema_version", "source", "id", "type", "title", "body", "priority", "occurred_at", "dedupe_key",
  ].includes(key))) throw new ExternalNotificationInputError("Event contains an unsupported field");
  if (value.schema_version !== 1) throw new ExternalNotificationInputError("schema_version must be 1");
  const id = safeText(value.id, "id", 128, true);
  if (!KEY.test(id)) throw new ExternalNotificationInputError("id must be a stable key");
  const type = safeText(value.type, "type", 100, true);
  if (!TYPE.test(type)) throw new ExternalNotificationInputError("type must be a stable dotted key");
  const title = safeText(value.title, "title", 200, true);
  const body = safeText(value.body, "body", 12_000);
  const priority = value.priority === undefined ? 3 : value.priority;
  if (!Number.isInteger(priority) || Number(priority) < 1 || Number(priority) > 5) {
    throw new ExternalNotificationInputError("priority must be 1-5");
  }
  const occurredAt = value.occurred_at === undefined ? undefined : isoTime(value.occurred_at);
  const dedupeKey = value.dedupe_key === undefined ? undefined : safeText(value.dedupe_key, "dedupe_key", 128, true);
  if (dedupeKey !== undefined && !KEY.test(dedupeKey)) throw new ExternalNotificationInputError("dedupe_key must be a stable key");
  return {
    schema_version: 1, source, id, type, title, body,
    priority: Number(priority) as ExternalNotificationEvent["priority"],
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
    ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
  };
}

function safeText(input: unknown, label: string, maximum: number, singleLine = false): string {
  if (typeof input !== "string" || !input.trim() || input.length > maximum || CONTROL.test(input)
    || (singleLine && /[\r\n]/.test(input))) {
    throw new ExternalNotificationInputError(`${label} must contain 1-${maximum} safe characters`);
  }
  return input.trim();
}

function isoTime(input: unknown): string {
  const value = safeText(input, "occurred_at", 100, true);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ExternalNotificationInputError("occurred_at must be an ISO-8601 timestamp");
  }
  return new Date(value).toISOString();
}
