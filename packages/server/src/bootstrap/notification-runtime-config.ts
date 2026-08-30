import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  NOTIFICATION_DOMAINS,
  type NotificationDomain,
} from "../domains/notification/notification-envelope";
import type {
  NotificationPlatformTargetConfiguration,
  NtfyPlatformTarget,
  TelegramPlatformTarget,
} from "./notification-platform";

const MAX_CONFIG_BYTES = 64 * 1_024;
const MAX_TARGETS_PER_CHANNEL = 32;
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHAT_ID = /^-?[0-9]{1,20}$/;
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export class NotificationRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationRuntimeConfigError";
  }
}

export async function loadNotificationRuntimeTargets(input: {
  dataDir: string;
  filePath?: string;
}): Promise<NotificationPlatformTargetConfiguration> {
  const explicitPath = input.filePath?.trim();
  if (explicitPath && !isAbsolute(explicitPath)) {
    throw new NotificationRuntimeConfigError("TOTEMORA_NOTIFICATION_TARGETS_FILE must be an absolute path");
  }
  const filePath = explicitPath ?? resolve(input.dataDir, "secrets/notification-targets.json");
  const raw = await readSecretConfig(filePath, Boolean(explicitPath));
  if (raw === undefined) return { telegramTargets: [], ntfyTargets: [] };
  return parseRuntimeTargets(raw);
}

async function readSecretConfig(filePath: string, required: boolean): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ENOENT") && !required) return undefined;
    if (isNodeError(error, "ELOOP")) {
      throw new NotificationRuntimeConfigError("Notification target config must not be a symbolic link");
    }
    throw new NotificationRuntimeConfigError(`Unable to open notification target config (${nodeErrorCode(error)})`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new NotificationRuntimeConfigError("Notification target config must be a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      throw new NotificationRuntimeConfigError("Notification target config permissions must not allow group or world access");
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new NotificationRuntimeConfigError(`Notification target config exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
      throw new NotificationRuntimeConfigError(`Notification target config exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    return raw;
  } finally {
    await handle.close();
  }
}

function parseRuntimeTargets(raw: string): NotificationPlatformTargetConfiguration {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { throw new NotificationRuntimeConfigError("Notification target config must be valid JSON"); }
  const value = strictObject(parsed, "notification target config", ["schema_version", "telegram", "ntfy"]);
  if (value.schema_version !== 1) throw new NotificationRuntimeConfigError("Notification target config schema_version must be 1");
  return {
    telegramTargets: targetArray(value.telegram, "telegram").map(parseTelegramTarget),
    ntfyTargets: targetArray(value.ntfy, "ntfy").map(parseNtfyTarget),
  };
}

function parseTelegramTarget(input: unknown): TelegramPlatformTarget {
  const value = strictObject(input, "Telegram notification target", [
    "id", "label", "chat_id", "domains", "enabled",
  ]);
  const id = targetId(value.id, "Telegram");
  const chatId = text(value.chat_id, `Telegram target ${id} chat_id`, 20);
  if (!CHAT_ID.test(chatId)) throw new NotificationRuntimeConfigError(`Telegram target ${id} chat_id is invalid`);
  return {
    id,
    chat_id: chatId,
    domains: domains(value.domains, id),
    enabled: enabled(value.enabled, id),
    ...optionalLabel(value.label, id),
  };
}

function parseNtfyTarget(input: unknown): NtfyPlatformTarget {
  const value = strictObject(input, "ntfy notification target", [
    "id", "label", "server_url", "topic", "authorization", "domains", "enabled",
  ]);
  const id = targetId(value.id, "ntfy");
  const topic = text(value.topic, `ntfy target ${id} topic`, 64);
  if (!TOPIC.test(topic)) throw new NotificationRuntimeConfigError(`ntfy target ${id} topic is invalid`);
  const authorization = value.authorization === undefined
    ? undefined
    : text(value.authorization, `ntfy target ${id} authorization`, 4_096);
  return {
    id,
    server_url: text(value.server_url, `ntfy target ${id} server_url`, 2_048),
    topic,
    domains: domains(value.domains, id),
    enabled: enabled(value.enabled, id),
    ...(authorization ? { authorization } : {}),
    ...optionalLabel(value.label, id),
  };
}

function targetArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TARGETS_PER_CHANNEL) {
    throw new NotificationRuntimeConfigError(`${label} targets must be an array with at most ${MAX_TARGETS_PER_CHANNEL} entries`);
  }
  return value;
}

function domains(value: unknown, targetIdValue: string): NotificationDomain[] {
  if (!Array.isArray(value) || !value.length || value.length > NOTIFICATION_DOMAINS.length) {
    throw new NotificationRuntimeConfigError(`Notification target ${targetIdValue} domains must contain 1-${NOTIFICATION_DOMAINS.length} entries`);
  }
  const result: NotificationDomain[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !NOTIFICATION_DOMAINS.includes(item as NotificationDomain)) {
      throw new NotificationRuntimeConfigError(`Notification target ${targetIdValue} has an unsupported domain`);
    }
    if (!result.includes(item as NotificationDomain)) result.push(item as NotificationDomain);
  }
  return result;
}

function strictObject(input: unknown, label: string, allowedKeys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new NotificationRuntimeConfigError(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknown) throw new NotificationRuntimeConfigError(`${label} contains unsupported field ${unknown}`);
  return value;
}

function targetId(value: unknown, channel: string): string {
  const id = text(value, `${channel} target id`, 64);
  if (!TARGET_ID.test(id)) throw new NotificationRuntimeConfigError(`${channel} target id is invalid`);
  return id;
}

function optionalLabel(value: unknown, id: string): { label?: string } {
  return value === undefined ? {} : { label: text(value, `Notification target ${id} label`, 80) };
}

function enabled(value: unknown, id: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new NotificationRuntimeConfigError(`Notification target ${id} enabled must be boolean`);
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new NotificationRuntimeConfigError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    throw new NotificationRuntimeConfigError(`${label} must contain 1-${maximum} safe characters`);
  }
  return normalized;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function nodeErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown error";
}
