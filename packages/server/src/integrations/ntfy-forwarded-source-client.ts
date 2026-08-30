import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { normalizeForwardedEvent, type ForwardedEventInput } from "../domains/forwarded/forwarded-event";
import { readBoundedResponseText } from "./bounded-response";

const MAX_CREDENTIAL_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_EVENTS = 100;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface SourceCredentials { source_url: string; authorization: string }

export class NtfyForwardedSourceClient {
  readonly source_id = "legacy-forwarded";

  constructor(private readonly options: {
    credentialsFile?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }) {}

  async configured(): Promise<boolean> {
    if (!this.options.credentialsFile) return false;
    try { await this.readCredentials(); return true; }
    catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async collect(sinceEpoch: number): Promise<ForwardedEventInput[]> {
    if (!Number.isSafeInteger(sinceEpoch) || sinceEpoch < 0) throw new Error("Forwarded source cursor is invalid");
    const credentials = await this.readCredentials();
    const endpoint = subscriptionEndpoint(credentials.source_url, sinceEpoch);
    const response = await (this.options.fetchImpl ?? fetch)(endpoint, {
      headers: {
        Accept: "application/x-ndjson, application/json",
        Authorization: credentials.authorization,
        "Cache-Control": "no-cache",
        "User-Agent": "Totemora-forwarded/1.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    if (!response.ok) throw new Error(`Forwarded ntfy source returned HTTP ${response.status}`);
    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, "Forwarded ntfy response exceeds 2097152 bytes");
    const events: ForwardedEventInput[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { throw new Error("Forwarded ntfy source returned invalid NDJSON"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const value = parsed as Record<string, unknown>;
      if (value.event !== "message") continue;
      events.push(ntfyEvent(value, this.source_id));
      if (events.length > MAX_EVENTS) throw new Error(`Forwarded ntfy poll exceeds ${MAX_EVENTS} messages`);
    }
    return events;
  }

  private async readCredentials(): Promise<SourceCredentials> {
    if (!this.options.credentialsFile) throw new Error("Forwarded ntfy source is not configured");
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(this.options.credentialsFile, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (isNodeError(error, "ENOENT")) throw error;
      throw new Error(`Unable to open forwarded source credentials (${nodeCode(error)})`);
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("Forwarded source credentials must be a regular file");
      if ((metadata.mode & 0o077) !== 0) throw new Error("Forwarded source credentials must use owner-only permissions");
      if (metadata.size < 1 || metadata.size > MAX_CREDENTIAL_BYTES) {
        throw new Error(`Forwarded source credentials must contain 1-${MAX_CREDENTIAL_BYTES} bytes`);
      }
      const lines = (await handle.readFile("utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length !== 3) throw new Error("Forwarded source credentials must contain source URL, username, and password");
      const [source, username, password] = lines as [string, string, string];
      const sourceUrl = sourceEndpoint(source);
      boundedCredential(username, "username", 200);
      boundedCredential(password, "password", 500);
      return {
        source_url: sourceUrl,
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      };
    } finally { await handle.close(); }
  }
}

function ntfyEvent(value: Record<string, unknown>, sourceId: string): ForwardedEventInput {
  if (typeof value.id !== "string") throw new Error("Forwarded ntfy message id is missing");
  if (!Number.isSafeInteger(value.time) || Number(value.time) < 1) throw new Error("Forwarded ntfy message time is invalid");
  const title = typeof value.title === "string" ? value.title : "";
  const body = typeof value.message === "string" ? value.message : "";
  const tags = value.tags === undefined ? [] : value.tags;
  if (!Array.isArray(tags)) throw new Error("Forwarded ntfy tags must be an array");
  const priority = value.priority === undefined ? 3 : value.priority;
  return normalizeForwardedEvent({
    source_id: sourceId,
    source_message_id: value.id,
    occurred_at: new Date(Number(value.time) * 1_000).toISOString(),
    title,
    body,
    priority: Number(priority),
    tags: tags as string[],
    ...(typeof value.click === "string" && value.click ? { click_url: value.click } : {}),
    ...(typeof value.icon === "string" && value.icon ? { image_url: value.icon } : {}),
  });
}

function subscriptionEndpoint(sourceUrl: string, sinceEpoch: number): URL {
  const url = new URL(sourceUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/json`;
  url.search = new URLSearchParams({ poll: "1", since: String(sinceEpoch) }).toString();
  url.hash = "";
  return url;
}

function sourceEndpoint(value: string): string {
  let url: URL;
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`;
  try { url = new URL(candidate); }
  catch { throw new Error("Forwarded source URL must be valid HTTPS"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.pathname.split("/").filter(Boolean).length) {
    throw new Error("Forwarded source URL must be HTTPS with a topic path and no credentials");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function boundedCredential(value: string, label: string, maximum: number): void {
  if (!value || value.length > maximum || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error(`Forwarded source ${label} is invalid`);
  }
}
function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function nodeCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
}
