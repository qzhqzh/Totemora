import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { NotificationDomain } from "../domains/notification/notification-envelope";
import { LEGACY_NTFY_TOPICS, NtfyNotificationClient } from "../integrations/ntfy-notification-client";
import { loadNotificationRuntimeTargets } from "./notification-runtime-config";

const LEGACY_DOMAINS: NotificationDomain[] = [
  "ai", "finance", "reminder", "deals", "forwarded", "content",
];

export interface LegacyNtfyTargetConfigReport {
  output_file: string;
  telegram_targets_preserved: number;
  custom_ntfy_targets_preserved: number;
  legacy_targets: Array<{ id: string; domain: NotificationDomain; topic: string }>;
}

export async function configureLegacyNtfyTargets(input: {
  credentialsFile: string;
  outputFile: string;
  serverUrl?: string;
}): Promise<LegacyNtfyTargetConfigReport> {
  const authorization = await basicAuthorization(input.credentialsFile);
  const current = await loadNotificationRuntimeTargets({
    dataDir: dirname(dirname(input.outputFile)),
    filePath: input.outputFile,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("Unable to open")
      && error.message.includes("ENOENT")) return { telegramTargets: [], ntfyTargets: [] };
    throw error;
  });
  const customNtfy = current.ntfyTargets.filter((target) => !target.id.startsWith("legacy-ntfy-"));
  const serverUrl = input.serverUrl ?? "http://127.0.0.1:40011";
  new NtfyNotificationClient([{ id: "configuration-check", server_url: serverUrl, topic: "memo" }]);
  const legacyTargets = LEGACY_DOMAINS.map((domain) => ({
    id: `legacy-ntfy-${domain}`,
    label: `Legacy ${domain} topic`,
    server_url: serverUrl,
    topic: LEGACY_NTFY_TOPICS[domain],
    authorization,
    domains: [domain],
    enabled: true,
  }));
  const payload = JSON.stringify({
    schema_version: 1,
    telegram: current.telegramTargets,
    ntfy: [...customNtfy, ...legacyTargets],
  }, null, 2);
  await atomicSecretWrite(input.outputFile, `${payload}\n`);
  return {
    output_file: basename(input.outputFile),
    telegram_targets_preserved: current.telegramTargets.length,
    custom_ntfy_targets_preserved: customNtfy.length,
    legacy_targets: legacyTargets.map((target) => ({
      id: target.id, domain: target.domains[0]!, topic: target.topic,
    })),
  };
}

async function basicAuthorization(credentialsFile: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(credentialsFile, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new Error(`Unable to open ntfy credentials (${nodeCode(error)})`); }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 3 || metadata.size > 4_096) {
      throw new Error("ntfy credentials must be a bounded regular file");
    }
    if ((metadata.mode & 0o077) !== 0) throw new Error("ntfy credentials must have private permissions");
    const lines = (await handle.readFile("utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 2) throw new Error("ntfy credentials must contain username and password lines");
    const [username, password] = lines;
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(username!) || password!.length < 8 || password!.length > 256
      || /[\u0000-\u001F\u007F:]/.test(password!)) {
      throw new Error("ntfy credentials are invalid");
    }
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  } finally {
    await handle.close();
  }
}

async function atomicSecretWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function nodeCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}
