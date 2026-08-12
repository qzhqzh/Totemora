import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { StateDatabase } from "./state-database";

export type BarkDomain = "ai" | "finance";

export interface BarkMessage {
  title: string;
  body: string;
  url?: string;
  id?: string;
  domain?: BarkDomain;
}

export interface BarkTarget {
  id: string;
  label?: string;
  server_url: string;
  domains: BarkDomain[];
  enabled: boolean;
  source?: "legacy" | "managed" | "environment";
  key_suffix?: string;
}

export interface BarkTargetMutationInput {
  id: string;
  label?: unknown;
  device_key?: unknown;
  domains?: unknown;
  enabled?: unknown;
  server_url?: unknown;
}

export interface BarkManagementAudit {
  id: string;
  action: "created" | "updated" | "tested" | "test_failed";
  target_id: string;
  actor: "operator";
  at: string;
  key_changed?: boolean;
  before?: BarkTarget;
  after?: BarkTarget;
  detail?: string;
}

export class BarkTargetMutationError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
    this.name = "BarkTargetMutationError";
  }
}

export interface BarkTargetStatus extends BarkTarget {
  channel_status: "ready" | "degraded" | "open";
  consecutive_failures: number;
  retry_after?: string;
  error?: string;
  healthy?: boolean;
}

export interface BarkStatus {
  configured: boolean;
  server_url?: string;
  healthy?: boolean;
  channel_status: "ready" | "unconfigured" | "degraded" | "open";
  consecutive_failures: number;
  retry_after?: string;
  error?: string;
  targets: BarkTargetStatus[];
}

export interface BarkReceipt {
  target_id: string;
  status: number;
  accepted: true;
  receipts?: BarkReceipt[];
  failures?: BarkPushFailure[];
}

export interface BarkPushFailure {
  target_id: string;
  error: string;
  retryable: boolean;
  status?: number;
}

export class BarkDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly outcomeUncertain = false,
    readonly targetId?: string,
    readonly retryAfter?: Date,
  ) {
    super(message);
  }
}

interface BarkConfig {
  targets: BarkTargetConfig[];
}

interface BarkTargetConfig extends BarkTarget {
  deviceKey: string;
  authorization?: string;
  source: "legacy" | "managed" | "environment";
}

interface BarkTargetInput {
  id?: unknown;
  label?: unknown;
  device_key?: unknown;
  domains?: unknown;
  enabled?: unknown;
  server_url?: unknown;
}

interface ChannelRow {
  status: "ready" | "degraded" | "open";
  consecutive_failures: number;
  retry_after: string | null;
  last_error: string | null;
}

const ALL_DOMAINS: BarkDomain[] = ["ai", "finance"];
const VALID_DOMAINS = new Set<BarkDomain>(ALL_DOMAINS);
const LOCALHOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const managementLocks = new Map<string, Promise<void>>();

export class BarkNotificationService {
  private readonly state: StateDatabase;

  constructor(
    private readonly dataDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.state = StateDatabase.open(dataDir);
  }

  async configured(): Promise<boolean> {
    const config = await this.loadConfig();
    return Boolean(config?.targets.length);
  }

  /** Return configured target metadata without device keys or authorization data. */
  async targets(): Promise<BarkTarget[]> {
    const config = await this.loadConfig();
    return config?.targets.map((target) => publicTarget(target)) ?? [];
  }

  async managementStatus(checkHealth = false): Promise<BarkStatus & { write_enabled: boolean; write_reason?: string }> {
    return {
      ...await this.status(checkHealth),
      write_enabled: !process.env.TOTEMORA_BARK_TARGETS_JSON?.trim(),
      ...(process.env.TOTEMORA_BARK_TARGETS_JSON?.trim()
        ? { write_reason: "TOTEMORA_BARK_TARGETS_JSON is authoritative; edit the environment configuration instead" }
        : {}),
    };
  }

  async listManagementAudit(limit = 50): Promise<BarkManagementAudit[]> {
    return this.state.listRecords<BarkManagementAudit>("notification:bark-target-audit")
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  async upsertManagedTarget(
    input: BarkTargetMutationInput,
    mode: "create" | "update" | "upsert" = "upsert",
  ): Promise<BarkTarget> {
    if (process.env.TOTEMORA_BARK_TARGETS_JSON?.trim()) {
      throw new Error("Bark target management is read-only while TOTEMORA_BARK_TARGETS_JSON is configured");
    }
    return this.withManagementLock(async () => {
      const id = validateManagedTargetId(input.id);
      if (id === "primary") throw new Error("Bark target id primary is reserved for the existing legacy device");
      const targets = await this.loadManagedTargetInputs();
      const authorization = await this.loadAuthorization();
      await this.parseTargets(JSON.stringify(targets), authorization, "managed");
      const index = targets.findIndex((target) => target.id === id);
      if (mode === "create" && index >= 0) {
        throw new BarkTargetMutationError(`Bark target already exists: ${id}`, 409);
      }
      if (mode === "update" && index < 0) {
        throw new BarkTargetMutationError(`Bark target not found: ${id}`, 404);
      }
      const prior = index >= 0 ? targets[index]! : undefined;
      const priorConfig = prior
        ? (await this.parseTargets(JSON.stringify([prior]), authorization, "managed"))[0]
        : undefined;
      const deviceKeyInput = typeof input.device_key === "string" ? input.device_key.trim() : "";
      const deviceKey = deviceKeyInput || prior?.device_key;
      if (typeof deviceKey !== "string" || !deviceKey.trim()) throw new Error(`Bark target ${id} device_key is required`);
      if (/\s|\//.test(deviceKey) || deviceKey.length > 512) throw new Error(`Bark target ${id} device_key is invalid`);
      const label = input.label === undefined
        ? priorConfig?.label ?? id
        : validateTargetLabel(input.label, id);
      const domains = input.domains === undefined ? priorConfig?.domains ?? [...ALL_DOMAINS] : parseDomains(input.domains, id);
      if (!domains.length) throw new Error(`Bark target ${id} must receive at least one domain`);
      const enabled = input.enabled === undefined ? priorConfig?.enabled ?? true : input.enabled;
      if (typeof enabled !== "boolean") throw new Error(`Bark target ${id} enabled must be boolean`);
      const serverUrlInput = input.server_url === undefined
        ? priorConfig?.server_url ?? await this.defaultServerUrl()
        : typeof input.server_url === "string" ? input.server_url.trim() : "";
      const serverUrl = await this.validateManagedServerUrl(serverUrlInput);
      const next: BarkTargetInput = {
        id, label, device_key: deviceKey, domains, enabled, server_url: serverUrl,
      };
      const updated = [...targets];
      if (index >= 0) updated[index] = next; else updated.push(next);
      const validated = await this.parseTargets(JSON.stringify(updated), authorization, "managed");
      await this.writeManagedTargets(updated);
      const target = validated.find((candidate) => candidate.id === id)!;
      const before = priorConfig ? publicTarget(priorConfig) : undefined;
      const after = publicTarget(target);
      const keyChanged = !prior || Boolean(deviceKeyInput && deviceKeyInput !== prior.device_key);
      if (keyChanged || priorConfig?.server_url !== target.server_url) this.resetChannel(id);
      this.recordManagementAudit({
        action: before ? "updated" : "created", target_id: id,
        key_changed: keyChanged, before, after,
      });
      return after;
    });
  }

  async recordTestAudit(targetId: string, succeeded: boolean, detail: string): Promise<void> {
    const target = (await this.targets()).find((candidate) => candidate.id === targetId);
    this.recordManagementAudit({
      action: succeeded ? "tested" : "test_failed", target_id: targetId,
      after: target, detail: detail.slice(0, 300),
    });
  }

  /** Return enabled target IDs, optionally restricted to a notification domain. */
  async targetIds(domain?: BarkDomain): Promise<string[]> {
    if (domain !== undefined) assertDomain(domain);
    const config = await this.loadConfig();
    return config?.targets
      .filter((target) => target.enabled && (domain === undefined || target.domains.includes(domain)))
      .map((target) => target.id) ?? [];
  }

  /** Return enabled target IDs that advertise support for a domain. */
  async targetIdsForDomain(domain: BarkDomain): Promise<string[]> {
    return this.targetIds(domain);
  }

  // Keep a descriptive alias for callers that need the selected target metadata.
  async targetsForDomain(domain: BarkDomain): Promise<BarkTarget[]> {
    const ids = new Set(await this.targetIdsForDomain(domain));
    const configuredTargets = await this.targets();
    return configuredTargets.filter((target) => ids.has(target.id));
  }

  async status(checkHealth = false, domain?: BarkDomain): Promise<BarkStatus> {
    if (domain !== undefined) assertDomain(domain);
    const config = await this.loadConfig();
    if (!config) {
      return {
        configured: false,
        channel_status: "unconfigured",
        consecutive_failures: 0,
        targets: [],
      };
    }

    const targetStatuses = await Promise.all(config.targets
      .filter((target) => domain === undefined || target.domains.includes(domain))
      .map(async (target) => {
      const channel = this.channel(target.id);
      const status: BarkTargetStatus = {
        ...publicTarget(target),
        channel_status: channel.status,
        consecutive_failures: channel.consecutive_failures,
        retry_after: channel.retry_after ?? undefined,
        error: channel.last_error ? sanitizeError(channel.last_error, target) : undefined,
      };
      if (checkHealth && target.enabled) {
        try {
          const response = await this.fetchImpl(new URL("ping", ensureSlash(target.server_url)), {
            headers: target.authorization ? { authorization: target.authorization } : undefined,
            signal: AbortSignal.timeout(5_000),
            redirect: "error",
          });
          status.healthy = response.ok;
          if (!response.ok) status.error = `Bark health check failed (${response.status})`;
        } catch (error) {
          status.healthy = false;
          status.error = sanitizeError(error instanceof Error ? error.message : String(error), target);
        }
      }
      return status;
      }));

    // Keep the old top-level fields meaningful for existing callers. A primary
    // target remains authoritative when present; otherwise aggregate the
    // independent target states without allowing one open circuit to make a
    // healthy target look open.
    const primary = targetStatuses.find((target) => target.id === "primary") ?? targetStatuses[0];
    const enabledStatuses = targetStatuses.filter((target) => target.enabled);
    const channelStatus = aggregateChannelStatus(enabledStatuses);
    const topLevel = primary ?? enabledStatuses[0];
    return {
      configured: true,
      server_url: topLevel?.server_url,
      healthy: topLevel?.healthy,
      channel_status: enabledStatuses.length ? channelStatus : "unconfigured",
      consecutive_failures: topLevel?.consecutive_failures ?? 0,
      retry_after: topLevel?.retry_after,
      error: topLevel?.error,
      targets: targetStatuses,
    };
  }

  /**
   * Push to one explicitly selected target. The receipt deliberately contains
   * only the target ID and HTTP status, never the device key.
   */
  async pushTo(targetId: string, message: BarkMessage): Promise<BarkReceipt> {
    const config = await this.loadConfig();
    if (!config) throw new BarkDeliveryError("Bark is not configured", false, undefined, false, targetId);
    const target = config.targets.find((item) => item.id === targetId);
    if (!target) throw new BarkDeliveryError(`Bark target is not configured: ${targetId}`, false, undefined, false, targetId);
    if (!target.enabled) throw new BarkDeliveryError(`Bark target is disabled: ${targetId}`, false, undefined, false, targetId);
    return this.sendToTarget(target, message);
  }

  /**
   * Backwards-compatible push API. Without a domain it sends to every enabled
   * target; with a domain it sends only to enabled targets advertising it.
   * A single-target result keeps the old { status, accepted } shape while also
   * adding target_id. Multi-target results include per-target receipts and any
   * isolated failures.
   */
  async push(message: BarkMessage, domain?: BarkDomain): Promise<BarkReceipt> {
    const config = await this.loadConfig();
    if (!config) throw new BarkDeliveryError("Bark is not configured", false);
    const selectedDomain = domain ?? message.domain;
    if (selectedDomain !== undefined) assertDomain(selectedDomain);
    const selected = config.targets.filter((target) => (
      target.enabled && (selectedDomain === undefined || target.domains.includes(selectedDomain))
    ));
    if (!selected.length) {
      const suffix = selectedDomain ? ` for domain ${selectedDomain}` : "";
      throw new BarkDeliveryError(`No enabled Bark targets are configured${suffix}`, false);
    }

    const receipts: BarkReceipt[] = [];
    const failures: BarkPushFailure[] = [];
    for (const target of selected) {
      try {
        receipts.push(await this.sendToTarget(target, message));
      } catch (error) {
        if (!(error instanceof BarkDeliveryError)) throw error;
        failures.push({
          target_id: target.id,
          error: error.message,
          retryable: error.retryable,
          ...(error.status === undefined ? {} : { status: error.status }),
        });
      }
    }

    if (!receipts.length) {
      const firstFailure = failures[0];
      if (firstFailure) {
        const target = selected.find((item) => item.id === firstFailure.target_id);
        throw new BarkDeliveryError(
          firstFailure.error,
          firstFailure.retryable,
          firstFailure.status,
          firstFailure.retryable,
          target?.id,
        );
      }
      throw new BarkDeliveryError("Bark push failed without a delivery result", true);
    }

    const first = receipts[0]!;
    if (selected.length === 1) return first;
    return {
      ...first,
      receipts,
      ...(failures.length ? { failures } : {}),
    };
  }

  private async sendToTarget(target: BarkTargetConfig, message: BarkMessage): Promise<BarkReceipt> {
    const channel = this.channel(target.id);
    if (channel.status === "open" && channel.retry_after && Date.parse(channel.retry_after) > Date.now()) {
      throw new BarkDeliveryError(
        `Bark circuit is open for target ${target.id} until ${channel.retry_after}`,
        true,
        undefined,
        false,
        target.id,
        new Date(channel.retry_after),
      );
    }

    const endpoint = new URL("push", ensureSlash(target.server_url));
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(target.authorization ? { authorization: target.authorization } : {}),
        },
        body: JSON.stringify({
          device_key: target.deviceKey,
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
      const detail = sanitizeError(error instanceof Error ? error.message : String(error), target);
      this.failure(target.id, detail);
      throw new BarkDeliveryError(`Bark request failed: ${detail}`, true, undefined, true, target.id);
    }

    if (!response.ok) {
      let body = "unreadable response body";
      try { body = (await response.text()).slice(0, 2_000); } catch {}
      body = sanitizeError(body, target);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      this.failure(target.id, `HTTP ${response.status}: ${body}`);
      throw new BarkDeliveryError(`Bark push failed (${response.status}): ${body}`, retryable, response.status, false, target.id);
    }
    this.success(target.id);
    return { target_id: target.id, status: response.status, accepted: true };
  }

  private channel(targetId: string): ChannelRow {
    return (this.state.db.query(`
      SELECT status,consecutive_failures,retry_after,last_error FROM channel_state WHERE channel=?
    `).get(channelName(targetId)) as ChannelRow | null) ?? {
      status: "ready", consecutive_failures: 0, retry_after: null, last_error: null,
    };
  }

  private success(targetId: string): void {
    this.resetChannel(targetId);
  }

  private resetChannel(targetId: string): void {
    this.state.db.query(`
      INSERT INTO channel_state(channel,status,consecutive_failures,retry_after,last_error,updated_at)
      VALUES(?, 'ready', 0, NULL, NULL, ?)
      ON CONFLICT(channel) DO UPDATE SET
        status='ready',consecutive_failures=0,retry_after=NULL,last_error=NULL,updated_at=excluded.updated_at
    `).run(channelName(targetId), new Date().toISOString());
  }

  private failure(targetId: string, error: string): void {
    const prior = this.channel(targetId);
    const failures = prior.consecutive_failures + 1;
    const open = failures >= 3;
    const retryAfter = open ? new Date(Date.now() + 30 * 60_000).toISOString() : null;
    this.state.db.query(`
      INSERT INTO channel_state(channel,status,consecutive_failures,retry_after,last_error,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(channel) DO UPDATE SET
        status=excluded.status,consecutive_failures=excluded.consecutive_failures,
        retry_after=excluded.retry_after,last_error=excluded.last_error,updated_at=excluded.updated_at
    `).run(channelName(targetId), open ? "open" : "degraded", failures, retryAfter, error.slice(0, 500), new Date().toISOString());
  }

  private async loadConfig(): Promise<BarkConfig | undefined> {
    const rawTargets = await this.loadTargetsJson();
    const authorization = await this.loadAuthorization();
    const explicitSource = process.env.TOTEMORA_BARK_TARGETS_JSON?.trim() ? "environment" : "managed";
    const explicitTargets = rawTargets === undefined ? [] : await this.parseTargets(rawTargets, authorization, explicitSource);
    const legacyTarget = await this.loadLegacyTarget(authorization);

    // New target configuration is additive to the old single-key setting. If
    // it defines primary explicitly, that target replaces the legacy primary.
    const combined = legacyTarget && !explicitTargets.some((target) => target.id === "primary")
      ? [legacyTarget, ...explicitTargets]
      : explicitTargets.length ? explicitTargets : legacyTarget ? [legacyTarget] : [];
    const targets = dedupeTargets(combined);
    return targets.length ? { targets } : undefined;
  }

  private async loadTargetsJson(): Promise<string | undefined> {
    const environment = process.env.TOTEMORA_BARK_TARGETS_JSON?.trim();
    if (environment) return environment;
    return this.loadSecret("bark-targets.json");
  }

  private async parseTargets(
    raw: string,
    authorization?: string,
    source: BarkTargetConfig["source"] = "managed",
  ): Promise<BarkTargetConfig[]> {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("Bark targets configuration must be valid JSON"); }
    if (!Array.isArray(parsed)) throw new Error("Bark targets configuration must be an array");

    const ids = new Set<string>();
    const targets: BarkTargetConfig[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Each Bark target must be an object");
      }
      const input = item as BarkTargetInput;
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) throw new Error("Bark target id is required");
      if (ids.has(id)) throw new Error(`Bark target id is duplicated: ${id}`);
      ids.add(id);

      const deviceKey = typeof input.device_key === "string" ? input.device_key.trim() : "";
      if (!deviceKey) throw new Error(`Bark target ${id} device_key is required`);
      const label = input.label === undefined ? id : validateTargetLabel(input.label, id);
      const domains = parseDomains(input.domains, id);
      const enabled = input.enabled === undefined ? true : input.enabled;
      if (typeof enabled !== "boolean") throw new Error(`Bark target ${id} enabled must be boolean`);

      const serverValue = input.server_url === undefined
        ? await this.defaultServerUrl()
        : typeof input.server_url === "string" ? input.server_url.trim() : "";
      if (!serverValue) throw new Error(`Bark target ${id} server_url is required`);
      targets.push({
        id,
        label,
        server_url: validateServerUrl(serverValue),
        domains,
        enabled,
        deviceKey,
        authorization,
        source,
      });
    }
    return targets;
  }

  private async loadLegacyTarget(authorization?: string): Promise<BarkTargetConfig | undefined> {
    let deviceKey = process.env.TOTEMORA_BARK_DEVICE_KEY
      ?? await this.loadSecret("bark-device-key")
      ?? "";
    deviceKey = deviceKey.trim();
    let selectedServer = process.env.TOTEMORA_BARK_SERVER_URL
      ?? await this.loadSecret("bark-server-url")
      ?? "http://127.0.0.1:18080";
    selectedServer = selectedServer.trim();

    if (!deviceKey && process.env.TOTEMORA_BARK_ALLOW_LEGACY === "true") {
      const legacy = process.env.TOTEMORA_BARK_BASE_URL ?? await this.loadSecret("bark-url");
      if (legacy) {
        try {
          const parsed = new URL(legacy.trim());
          const pathKey = parsed.pathname.split("/").filter(Boolean)[0];
          if (pathKey) {
            deviceKey = pathKey;
            selectedServer = parsed.origin;
          }
        } catch {
          throw new Error("Bark legacy URL is invalid");
        }
      }
    }
    if (!deviceKey) return undefined;
    return {
      id: "primary",
      label: "现有主设备",
      server_url: validateServerUrl(selectedServer),
      deviceKey,
      domains: [...ALL_DOMAINS],
      enabled: true,
      authorization,
      source: "legacy",
    };
  }

  private async defaultServerUrl(): Promise<string> {
    return (
      process.env.TOTEMORA_BARK_SERVER_URL
      ?? await this.loadSecret("bark-server-url")
      ?? "http://127.0.0.1:18080"
    ).trim();
  }

  private async validateManagedServerUrl(value: string): Promise<string> {
    const validated = validateServerUrl(value);
    const allowedOrigins = new Set<string>([
      new URL(validateServerUrl(await this.defaultServerUrl())).origin,
      ...(process.env.TOTEMORA_BARK_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((candidate) => new URL(validateServerUrl(candidate)).origin),
    ]);
    if (!allowedOrigins.has(new URL(validated).origin)) {
      throw new Error("Bark server origin is not allowlisted; configure TOTEMORA_BARK_SERVER_URL or TOTEMORA_BARK_ALLOWED_ORIGINS");
    }
    return validated;
  }

  private async loadAuthorization(): Promise<string | undefined> {
    const user = process.env.TOTEMORA_BARK_BASIC_AUTH_USER ?? await this.loadSecret("bark-basic-auth-user");
    const password = process.env.TOTEMORA_BARK_BASIC_AUTH_PASSWORD ?? await this.loadSecret("bark-basic-auth-password");
    return user || password ? `Basic ${Buffer.from(`${user ?? ""}:${password ?? ""}`).toString("base64")}` : undefined;
  }

  private async loadSecret(name: string): Promise<string | undefined> {
    try { return (await readFile(resolve(this.dataDir, "secrets", name), "utf8")).trim() || undefined; }
    catch { return undefined; }
  }

  private async loadManagedTargetInputs(): Promise<BarkTargetInput[]> {
    const raw = await this.loadSecret("bark-targets.json");
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("Bark targets configuration must be valid JSON"); }
    if (!Array.isArray(parsed)) throw new Error("Bark targets configuration must be an array");
    return parsed as BarkTargetInput[];
  }

  private async writeManagedTargets(targets: BarkTargetInput[]): Promise<void> {
    const directory = resolve(this.dataDir, "secrets");
    const path = resolve(directory, "bark-targets.json");
    const temporary = resolve(directory, `.bark-targets.${process.pid}.${crypto.randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(targets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  private recordManagementAudit(input: Omit<BarkManagementAudit, "id" | "actor" | "at">): void {
    const audit: BarkManagementAudit = {
      id: crypto.randomUUID(), actor: "operator", at: new Date().toISOString(), ...input,
    };
    this.state.putRecord("notification:bark-target-audit", audit.id, audit, audit.at, audit.at);
  }

  private async withManagementLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = managementLocks.get(this.dataDir) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const barrier = run.then(() => undefined, () => undefined);
    managementLocks.set(this.dataDir, barrier);
    try { return await run; }
    finally { if (managementLocks.get(this.dataDir) === barrier) managementLocks.delete(this.dataDir); }
  }
}

function parseDomains(value: unknown, targetId: string): BarkDomain[] {
  if (value === undefined) return [...ALL_DOMAINS];
  if (!Array.isArray(value)) throw new Error(`Bark target ${targetId} domains must be an array`);
  const domains: BarkDomain[] = [];
  for (const valueItem of value) {
    if (typeof valueItem !== "string" || !VALID_DOMAINS.has(valueItem as BarkDomain)) {
      throw new Error(`Bark target ${targetId} has unsupported domain`);
    }
    const domain = valueItem as BarkDomain;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

function assertDomain(value: string): asserts value is BarkDomain {
  if (!VALID_DOMAINS.has(value as BarkDomain)) throw new Error(`Unsupported Bark domain: ${value}`);
}

function validateManagedTargetId(value: string): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error("Bark target id must be 1-64 letters, numbers, dots, underscores, or dashes");
  }
  return id;
}

function validateTargetLabel(value: unknown, targetId: string): string {
  if (typeof value !== "string") throw new Error(`Bark target ${targetId} label must be a string`);
  const label = value.trim();
  if (!label || label.length > 80) throw new Error(`Bark target ${targetId} label must be 1-80 characters`);
  return label;
}

function validateServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Bark server URL is invalid"); }
  const local = LOCALHOSTS.has(url.hostname);
  if (!["http:", "https:"].includes(url.protocol) || (url.protocol !== "https:" && !local)) {
    throw new Error("Bark server must use HTTPS unless it is localhost");
  }
  if (url.username || url.password) throw new Error("Bark server URL must not contain credentials");
  return url.toString();
}

function publicTarget(target: BarkTargetConfig): BarkTarget {
  return {
    id: target.id,
    label: target.label,
    server_url: redact(target.server_url),
    domains: [...target.domains],
    enabled: target.enabled,
    source: target.source,
    key_suffix: target.deviceKey.length >= 8 ? target.deviceKey.slice(-4) : undefined,
  };
}

function dedupeTargets(targets: BarkTargetConfig[]): BarkTargetConfig[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.server_url}\u0000${target.deviceKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function channelName(targetId: string): string {
  return `bark:${targetId}`;
}

function aggregateChannelStatus(statuses: BarkTargetStatus[]): "ready" | "degraded" | "open" {
  if (!statuses.length) return "ready";
  if (statuses.every((status) => status.channel_status === "open")) return "open";
  if (statuses.some((status) => status.channel_status !== "ready")) return "degraded";
  return "ready";
}

function sanitizeError(value: string, target: BarkTargetConfig): string {
  return [target.deviceKey, target.authorization]
    .filter((secret): secret is string => Boolean(secret))
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
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
