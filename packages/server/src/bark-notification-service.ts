import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { StateDatabase } from "./state-database";

export interface BarkStatus {
  configured: boolean;
  server_url?: string;
  healthy?: boolean;
  channel_status: "ready" | "unconfigured" | "degraded" | "open";
  consecutive_failures: number;
  retry_after?: string;
  error?: string;
}

export class BarkDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
  }
}

interface BarkConfig {
  serverUrl: string;
  deviceKey: string;
  authorization?: string;
}

interface ChannelRow {
  status: "ready" | "degraded" | "open";
  consecutive_failures: number;
  retry_after: string | null;
  last_error: string | null;
}

export class BarkNotificationService {
  private readonly state: StateDatabase;

  constructor(
    private readonly dataDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.state = StateDatabase.open(dataDir);
  }

  async configured(): Promise<boolean> {
    return Boolean(await this.loadConfig());
  }

  async status(checkHealth = false): Promise<BarkStatus> {
    const config = await this.loadConfig();
    const channel = this.channel();
    if (!config) {
      return {
        configured: false, channel_status: "unconfigured", consecutive_failures: 0,
      };
    }
    const status: BarkStatus = {
      configured: true, server_url: redact(config.serverUrl),
      channel_status: channel.status, consecutive_failures: channel.consecutive_failures,
      retry_after: channel.retry_after ?? undefined, error: channel.last_error ?? undefined,
    };
    if (checkHealth) {
      try {
        const response = await this.fetchImpl(new URL("ping", ensureSlash(config.serverUrl)), {
          headers: config.authorization ? { authorization: config.authorization } : undefined,
          signal: AbortSignal.timeout(5_000), redirect: "error",
        });
        status.healthy = response.ok;
        if (!response.ok) status.error = `Bark health check failed (${response.status})`;
      } catch (error) {
        status.healthy = false;
        status.error = error instanceof Error ? error.message : String(error);
      }
    }
    return status;
  }

  async push(message: { title: string; body: string; url?: string; id?: string }): Promise<{ status: number; accepted: true }> {
    const config = await this.loadConfig();
    if (!config) throw new BarkDeliveryError("Bark is not configured", false);
    const channel = this.channel();
    if (channel.status === "open" && channel.retry_after && Date.parse(channel.retry_after) > Date.now()) {
      throw new BarkDeliveryError(`Bark circuit is open until ${channel.retry_after}`, true);
    }
    const target = new URL("push", ensureSlash(config.serverUrl));
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(config.authorization ? { authorization: config.authorization } : {}),
        },
        body: JSON.stringify({
          device_key: config.deviceKey,
          title: message.title,
          body: message.body,
          group: "Totemora 部落情报",
          ...(message.id ? { id: message.id } : {}),
          ...(message.url ? { url: message.url } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failure(message);
      throw new BarkDeliveryError(`Bark request failed: ${message}`, true);
    }
    const body = (await response.text()).slice(0, 2_000);
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      this.failure(`HTTP ${response.status}: ${body}`);
      throw new BarkDeliveryError(`Bark push failed (${response.status}): ${body}`, retryable, response.status);
    }
    this.success();
    return { status: response.status, accepted: true };
  }

  private channel(): ChannelRow {
    return (this.state.db.query(`
      SELECT status,consecutive_failures,retry_after,last_error FROM channel_state WHERE channel='bark'
    `).get() as ChannelRow | null) ?? {
      status: "ready", consecutive_failures: 0, retry_after: null, last_error: null,
    };
  }

  private success(): void {
    this.state.db.query(`
      INSERT INTO channel_state(channel,status,consecutive_failures,retry_after,last_error,updated_at)
      VALUES('bark','ready',0,NULL,NULL,?)
      ON CONFLICT(channel) DO UPDATE SET
        status='ready',consecutive_failures=0,retry_after=NULL,last_error=NULL,updated_at=excluded.updated_at
    `).run(new Date().toISOString());
  }

  private failure(error: string): void {
    const prior = this.channel();
    const failures = prior.consecutive_failures + 1;
    const open = failures >= 3;
    const retryAfter = open ? new Date(Date.now() + 30 * 60_000).toISOString() : null;
    this.state.db.query(`
      INSERT INTO channel_state(channel,status,consecutive_failures,retry_after,last_error,updated_at)
      VALUES('bark',?,?,?,?,?)
      ON CONFLICT(channel) DO UPDATE SET
        status=excluded.status,consecutive_failures=excluded.consecutive_failures,
        retry_after=excluded.retry_after,last_error=excluded.last_error,updated_at=excluded.updated_at
    `).run(open ? "open" : "degraded", failures, retryAfter, error.slice(0, 500), new Date().toISOString());
  }

  private async loadConfig(): Promise<BarkConfig | undefined> {
    const serverUrl = (
      process.env.TOTEMORA_BARK_SERVER_URL
      ?? await this.loadSecret("bark-server-url")
      ?? "http://127.0.0.1:18080"
    ).trim();
    let deviceKey = (
      process.env.TOTEMORA_BARK_DEVICE_KEY
      ?? await this.loadSecret("bark-device-key")
      ?? ""
    ).trim();
    let selectedServer = serverUrl;
    if (!deviceKey && process.env.TOTEMORA_BARK_ALLOW_LEGACY === "true") {
      const legacy = process.env.TOTEMORA_BARK_BASE_URL ?? await this.loadSecret("bark-url");
      if (legacy) {
        const parsed = new URL(legacy.trim());
        const pathKey = parsed.pathname.split("/").filter(Boolean)[0];
        if (pathKey) {
          deviceKey = pathKey;
          selectedServer = parsed.origin;
        }
      }
    }
    if (!deviceKey) return undefined;
    const url = new URL(selectedServer);
    const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (!["http:", "https:"].includes(url.protocol) || (url.protocol !== "https:" && !local)) {
      throw new Error("Bark server must use HTTPS unless it is localhost");
    }
    const user = process.env.TOTEMORA_BARK_BASIC_AUTH_USER ?? await this.loadSecret("bark-basic-auth-user");
    const password = process.env.TOTEMORA_BARK_BASIC_AUTH_PASSWORD ?? await this.loadSecret("bark-basic-auth-password");
    return {
      serverUrl: url.toString(), deviceKey,
      authorization: user || password ? `Basic ${Buffer.from(`${user ?? ""}:${password ?? ""}`).toString("base64")}` : undefined,
    };
  }

  private async loadSecret(name: string): Promise<string | undefined> {
    try { return (await readFile(resolve(this.dataDir, "secrets", name), "utf8")).trim() || undefined; }
    catch { return undefined; }
  }
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function redact(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/$/, "");
}
