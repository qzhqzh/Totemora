import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { NOTIFICATION_CHANNELS, NOTIFICATION_DOMAINS, type NotificationChannel, type NotificationDomain } from "../domains/notification/notification-envelope";
import type { NotificationIngressConfig } from "../domains/notification/notification-ingress-contract";
export type { NotificationIngressConfig } from "../domains/notification/notification-ingress-contract";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TYPE_PREFIX = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const ADDRESS = /^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+\.[^\s<>@,;"\\]+$/;
const MAX_BYTES = 64 * 1024;

export class NotificationIngressConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationIngressConfigError";
  }
}

export async function loadNotificationIngressConfig(input: {
  dataDir: string;
  filePath?: string;
}): Promise<NotificationIngressConfig> {
  const explicit = input.filePath?.trim();
  if (explicit && !isAbsolute(explicit)) throw fail("TOTEMORA_NOTIFICATION_INGRESS_FILE must be an absolute path");
  const path = explicit ?? resolve(input.dataDir, "secrets/notification-ingress.json");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!explicit && code(error) === "ENOENT") return { sources: [], rules: [], email: [] };
    throw fail(code(error) === "ELOOP" ? "Notification ingress config cannot be a symbolic link"
      : `Cannot open notification ingress config (${code(error)})`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) {
      throw fail("Notification ingress config must be a private regular file of at most 64 KiB");
    }
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw) > MAX_BYTES) throw fail("Notification ingress config exceeds 64 KiB");
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; }
    catch { throw fail("Notification ingress config must be valid JSON"); }
    return parseNotificationIngressConfig(parsed);
  } finally {
    await handle.close();
  }
}

export function parseNotificationIngressConfig(input: unknown): NotificationIngressConfig {
  const value = object(input, "notification ingress config", ["schema_version", "sources", "rules", "email", "smtp", "bark", "telegram_bot_token", "operator_token"]);
  if (value.schema_version !== 1) throw fail("Notification ingress schema_version must be 1");
  const sources = array(value.sources, "sources", 32).map((item) => {
    const row = object(item, "source", ["id", "token"]);
    const id = key(row.id, "source id");
    const token = string(row.token, "source token", 256);
    if (token.length < 32 || /\s/.test(token)) throw fail("source token must contain 32-256 non-whitespace characters");
    return { id, token };
  });
  const email = array(value.email, "email", 32).map((item) => {
    const row = object(item, "email target", ["id", "address", "enabled"]);
    const id = key(row.id, "email target id");
    const address = addressValue(row.address, "email target address");
    if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw fail("email target enabled must be a boolean");
    return { id, address, enabled: row.enabled !== false };
  });
  const bark = array(value.bark, "bark", 32).map((item) => {
    const row = object(item, "bark target", ["id", "device_key", "server_url", "authorization", "domains", "enabled", "label"]);
    const id = key(row.id, "bark target id");
    const url = string(row.server_url, "bark server_url", 2048);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw fail("bark server_url must be a URL"); }
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "bark"].includes(parsed.hostname)))
      || parsed.username || parsed.password || parsed.search || parsed.hash) throw fail("bark server_url must use HTTPS or a local service");
    if (!Array.isArray(row.domains) || !row.domains.length || row.domains.length > NOTIFICATION_DOMAINS.length
      || row.domains.some((domain) => !NOTIFICATION_DOMAINS.includes(domain as NotificationDomain))) throw fail("bark domains are invalid");
    if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw fail("bark enabled must be a boolean");
    return { id, device_key: string(row.device_key, "bark device_key", 256), server_url: parsed.toString(),
      domains: [...new Set(row.domains)] as NotificationDomain[], enabled: row.enabled !== false,
      ...(row.label === undefined ? {} : { label: string(row.label, "bark label", 80) }),
      ...(row.authorization === undefined ? {} : { authorization: string(row.authorization, "bark authorization", 4096) }),
    };
  });
  const telegramBotToken = value.telegram_bot_token === undefined ? undefined : string(value.telegram_bot_token, "telegram_bot_token", 256);
  if (telegramBotToken && !/^[0-9]{1,20}:[A-Za-z0-9_-]{10,}$/.test(telegramBotToken)) throw fail("telegram_bot_token is invalid");
  const operatorToken = value.operator_token === undefined ? undefined : string(value.operator_token, "operator_token", 256);
  if (operatorToken && (operatorToken.length < 32 || /\s/.test(operatorToken))) throw fail("operator_token must contain 32-256 non-whitespace characters");
  if (operatorToken && sources.some((source) => source.token === operatorToken)) {
    throw fail("operator_token must differ from every source token");
  }
  const rules = array(value.rules, "rules", 64).map((item) => {
    const row = object(item, "rule", ["id", "source", "type_prefix", "targets", "coalesce_window_seconds"]);
    const id = key(row.id, "rule id");
    const source = row.source === "*" ? "*" : key(row.source, "rule source");
    const typePrefix = string(row.type_prefix, "rule type_prefix", 100);
    if (!TYPE_PREFIX.test(typePrefix)) throw fail("rule type_prefix is invalid");
    const targets = array(row.targets, "rule targets", 32).map((target) => {
      const value = string(target, "rule target", 80);
      const [channel, targetId, extra] = value.split(":");
      if (!NOTIFICATION_CHANNELS.includes(channel as NotificationChannel) || !KEY.test(targetId ?? "") || extra !== undefined) {
        throw fail("rule target must be channel:id");
      }
      return value;
    });
    if (!targets.length || new Set(targets).size !== targets.length) throw fail("rule targets must be nonempty and unique");
    const window = row.coalesce_window_seconds ?? 0;
    if (!Number.isInteger(window) || Number(window) < 0 || Number(window) > 86_400) {
      throw fail("coalesce_window_seconds must be 0-86400");
    }
    return { id, source, type_prefix: typePrefix, targets, coalesce_window_seconds: Number(window) };
  });
  if (new Set(sources.map((item) => item.id)).size !== sources.length
    || new Set(sources.map((item) => item.token)).size !== sources.length
    || new Set(email.map((item) => item.id)).size !== email.length
    || new Set(bark.map((item) => item.id)).size !== bark.length
    || new Set(rules.map((item) => item.id)).size !== rules.length) throw fail("source, rule and email IDs must be unique");
  if (rules.some((rule) => rule.source !== "*" && !sources.some((source) => source.id === rule.source))) {
    throw fail("rule source is not configured");
  }
  const smtp = value.smtp === undefined ? undefined : parseSmtp(value.smtp);
  if (email.length && !smtp) throw fail("SMTP must be configured for email targets");
  for (const rule of rules) {
    for (const target of rule.targets) {
      if (target.startsWith("email:") && !email.some((item) => `email:${item.id}` === target)) {
        throw fail("rule references an unknown email target");
      }
    }
  }
  return { sources, rules, email, bark, ...(operatorToken ? { operator_token: operatorToken } : {}),
    ...(telegramBotToken ? { telegram_bot_token: telegramBotToken } : {}), ...(smtp ? { smtp } : {}) };
}

function parseSmtp(input: unknown): NonNullable<NotificationIngressConfig["smtp"]> {
  const row = object(input, "SMTP", ["host", "port", "secure", "user", "password", "from"]);
  const host = string(row.host, "SMTP host", 253);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || host.includes("..")) throw fail("SMTP host is invalid");
  if (!Number.isInteger(row.port) || Number(row.port) < 1 || Number(row.port) > 65535) throw fail("SMTP port is invalid");
  if (typeof row.secure !== "boolean") throw fail("SMTP secure must be a boolean");
  return {
    host, port: Number(row.port), secure: row.secure,
    user: string(row.user, "SMTP user", 256), password: string(row.password, "SMTP password", 512),
    from: addressValue(row.from, "SMTP from"),
  };
}

function object(input: unknown, label: string, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(`${label} must be an object`);
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some((field) => !fields.includes(field))) throw fail(`${label} has an unsupported field`);
  return row;
}

function array(input: unknown, label: string, maximum: number): unknown[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > maximum) throw fail(`${label} must contain at most ${maximum} items`);
  return input;
}

function string(input: unknown, label: string, maximum: number): string {
  if (typeof input !== "string" || !input.trim() || input.length > maximum || /[\u0000-\u001f\u007f]/.test(input)) {
    throw fail(`${label} must contain 1-${maximum} safe characters`);
  }
  return input.trim();
}

function key(input: unknown, label: string): string {
  const value = string(input, label, 64);
  if (!KEY.test(value)) throw fail(`${label} is invalid`);
  return value;
}

function addressValue(input: unknown, label: string): string {
  const value = string(input, label, 254);
  if (!ADDRESS.test(value)) throw fail(`${label} is invalid`);
  return value;
}

function fail(message: string): NotificationIngressConfigError { return new NotificationIngressConfigError(message); }
function code(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}
