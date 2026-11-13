import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseNotificationIngressConfig } from "./bootstrap/notification-ingress-config";

/** One-time, no-overwrite local credential transfer. This never prints credentials. */
export async function setupFromGateway(dataDir: string, apply = false) {
  const secrets = resolve(dataDir, "secrets");
  const bark = await readPrivateJson(resolve(secrets, "bark-targets.json"));
  const legacy = await readPrivateJson(resolve(secrets, "notification-targets.json"));
  if (!Array.isArray(bark) || !legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
    throw new Error("Legacy notification targets are invalid");
  }
  const targets = legacy as Record<string, unknown>;
  if (targets.schema_version !== 1 || !Array.isArray(targets.telegram) || !Array.isArray(targets.ntfy)) {
    throw new Error("Legacy notification targets use an unsupported schema");
  }
  if (targets.telegram.length) throw new Error("Telegram targets require an explicit bot-token migration; no credentials were written");
  const convertedBark: Array<Record<string, unknown>> = bark.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid Bark target");
    const entry = item as Record<string, unknown>;
    return { ...entry, server_url: internalUrl(entry.server_url, "bark", 18080, "http://bark:8080/") };
  });
  const convertedTargets = { schema_version: 1, telegram: [], ntfy: (targets.ntfy as unknown[]).map((item): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid ntfy target");
    const entry = item as Record<string, unknown>;
    return { ...entry, server_url: internalUrl(entry.server_url, "ntfy", 40011, "http://ntfy:80/") };
  }) };
  const token = randomBytes(32).toString("hex");
  const ingress = { schema_version: 1, operator_token: token, sources: [], rules: [], email: [], bark: convertedBark };
  parseNotificationIngressConfig(ingress);
  const result = { bark: convertedBark.map((item) => ({ id: item.id, domains: item.domains, enabled: item.enabled })),
    ntfy: convertedTargets.ntfy.map((item) => ({ id: item.id, domains: item.domains, enabled: item.enabled })),
    applied: apply };
  if (!apply) return result;
  const notifierSecrets = resolve(secrets, "notifier");
  await mkdir(notifierSecrets, { recursive: true, mode: 0o700 });
  const ingressPath = resolve(notifierSecrets, "notification-ingress.json");
  const targetPath = resolve(notifierSecrets, "notification-targets.json");
  const tokenPath = resolve(secrets, "notifier-token");
  // Fail before creating anything if a previous/hand-managed setup exists.
  for (const path of [ingressPath, targetPath, tokenPath]) {
    try { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); await file.close();
      throw new Error("Notifier credentials already exist; refusing to overwrite"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  await writeFile(targetPath, `${JSON.stringify(convertedTargets, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(ingressPath, `${JSON.stringify(ingress, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(tokenPath, `${token}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

async function readPrivateJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 64 * 1024) throw new Error("Legacy target file must be private and <= 64 KiB");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally { await handle.close(); }
}

function internalUrl(input: unknown, label: string, port: number, target: string): string {
  if (typeof input !== "string") throw new Error(`${label} URL is invalid`);
  const url = new URL(input);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    if (url.protocol !== "http:" || url.port !== String(port) || url.pathname !== "/"
      || url.search || url.hash || url.username || url.password) throw new Error(`Unexpected local ${label} URL; configure manually`);
    return target;
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`External ${label} URL must use HTTPS`);
  return url.toString();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply"].includes(arg))) throw new Error("Usage: bun run notifier:setup [--apply]");
  console.log(JSON.stringify(await setupFromGateway(resolve(".totemora"), args.includes("--apply")), null, 2));
}
