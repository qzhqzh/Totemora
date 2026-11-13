import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { readBoundedResponseText } from "./integrations/bounded-response";

const USAGE = `Notifier diagnostics (operator only):
  bun run notifier:doctor status
  bun run notifier:doctor targets
  bun run notifier:doctor events [--status failed|uncertain|unrouted|all] [--limit 25]
  bun run notifier:doctor event <event-uuid>
  bun run notifier:doctor deliveries [--key <idempotency-key>] [--limit 25]
  bun run notifier:doctor test <domain> <channel:target-id> <stable-key>
Options: --url <https-or-loopback-root>, --token-file <private-absolute-path>
Defaults: http://127.0.0.1:4321, .totemora/secrets/notifier-token`;

export async function runDiagnostics(args: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  if (args.length === 0 || args.includes("--help")) { console.log(USAGE); return 0; }
  const command = args.shift();
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      const key = args[i]!;
      if (!['--url', '--token-file', '--status', '--limit', '--key'].includes(key)
        || options.has(key) || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(USAGE);
      options.set(key, args[++i]!);
    } else positional.push(args[i]!);
  }
  const url = new URL(options.get("--url") ?? process.env.NOTIFIER_URL ?? "http://127.0.0.1:4321");
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Notifier URL must be HTTPS or a loopback service root");
  }
  const tokenPath = resolve(options.get("--token-file") ?? process.env.NOTIFIER_TOKEN_FILE
    ?? ".totemora/secrets/notifier-token");
  const handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1024) throw new Error("Operator token file must be private (0600)");
    token = (await handle.readFile("utf8")).trim();
    if (token.length < 32 || token.length > 256 || /\s/.test(token)) throw new Error("Operator token is invalid");
  } finally { await handle.close(); }

  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetchImpl(new URL(path, url), {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await readBoundedResponseText(response, 2_000_000, "Notifier response too large");
    const result = JSON.parse(raw) as unknown;
    if (!response.ok) throw new Error(`Notifier HTTP ${response.status}: ${typeof result === "object" && result && "error" in result ? String(result.error) : "request rejected"}`);
    return result;
  }
  let result: unknown;
  if (command === "status" && positional.length === 0 && options.size <= 2) {
    result = await request("api/v1/status");
  } else if (command === "targets" && positional.length === 0 && options.size <= 2) {
    result = await request("api/v1/targets");
  } else if (command === "events" && positional.length === 0 && [...options.keys()].every((key) =>
    ["--url", "--token-file", "--status", "--limit"].includes(key))) {
    const query = new URLSearchParams({ status: options.get("--status") ?? "all", limit: options.get("--limit") ?? "25" });
    const data = await request(`api/notifications/events?${query}`) as { events: unknown[] };
    result = { events: data.events.map(safeEvent) };
  } else if (command === "event" && positional.length === 1 && options.size <= 2) {
    if (!/^[0-9a-f-]{36}$/.test(positional[0]!)) throw new Error("Invalid event UUID");
    const data = await request(`api/notifications/events/${positional[0]}`) as { event: unknown };
    result = { event: safeEvent(data.event) };
  } else if (command === "deliveries" && positional.length === 0 && [...options.keys()].every((key) =>
    ["--url", "--token-file", "--key", "--limit"].includes(key))) {
    const query = new URLSearchParams({ limit: options.get("--limit") ?? "25" });
    if (options.has("--key")) query.set("idempotency_key", options.get("--key")!);
    result = await request(`api/v1/deliveries?${query}`);
  } else if (command === "test" && positional.length === 3 && options.size <= 2) {
    const [domain, destination, idempotency_key] = positional;
    const match = destination?.match(/^(bark|telegram|ntfy|email):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
    if (!match || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(idempotency_key ?? "")) throw new Error(USAGE);
    result = await request("api/v1/test", { schema_version: 1, domain, channel: match[1],
      target_id: match[2], idempotency_key });
    console.log(JSON.stringify(result, null, 2));
    return (result as { status?: string }).status === "completed" ? 0 : 1;
  } else throw new Error(USAGE);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function safeEvent(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const row = input as Record<string, unknown>;
  const raw = row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : undefined;
  const deliveries = Array.isArray(raw?.deliveries) ? raw.deliveries.map((item: Record<string, unknown>) => ({
    channel: item.channel, target_id: item.target_id, status: item.status,
    ...(item.error ? { error: item.error } : {}),
  })) : [];
  return { event_uuid: row.event_uuid, source: row.source, id: row.id, type: row.type,
    status: row.status, route_targets: row.route_targets, attempts: row.attempts,
    ...(row.last_error ? { last_error: row.last_error } : {}), deliveries,
    created_at: row.created_at, updated_at: row.updated_at };
}

if (import.meta.main) {
  try { process.exitCode = await runDiagnostics(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Notifier diagnostics failed"); process.exitCode = 2; }
}
