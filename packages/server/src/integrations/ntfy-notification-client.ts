import type {
  NotificationChannelAdapter,
  NotificationChannelReceipt,
} from "../application/notification-dispatcher";
import type {
  NotificationDomain,
  NotificationEnvelopeV1,
} from "../domains/notification/notification-envelope";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";
import { readBoundedResponseText } from "./bounded-response";

const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const NTFY_MESSAGE_LIMIT_BYTES = 3_800;
const NTFY_RESPONSE_LIMIT_BYTES = 8_192;

export const LEGACY_NTFY_TOPICS: Readonly<Record<NotificationDomain, string>> = Object.freeze({
  ai: "hotspot",
  finance: "finance",
  reminder: "memo",
  deals: "deals",
  forwarded: "forwarded",
  content: "x",
  ops: "ops",
});

export interface NtfyTargetConfig {
  id: string;
  server_url: string;
  topic: string;
  authorization?: string;
}

interface ValidatedNtfyTargetConfig extends NtfyTargetConfig {
  server_url: string;
}

export interface NtfyReceipt {
  accepted: true;
  target_id: string;
  topic: string;
  message_id: string;
  status: number;
}

export class NtfyDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly outcomeUncertain = false,
    readonly targetId?: string,
    readonly retryAfter?: Date,
  ) {
    super(message);
    this.name = "NtfyDeliveryError";
  }
}

export class NtfyNotificationClient {
  private readonly targets = new Map<string, ValidatedNtfyTargetConfig>();

  constructor(
    input: NtfyTargetConfig[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    for (const value of input) {
      const target = validateTarget(value);
      if (this.targets.has(target.id)) throw new Error(`Duplicate ntfy target: ${target.id}`);
      this.targets.set(target.id, target);
    }
  }

  async publish(targetId: string, envelope: NotificationEnvelopeV1): Promise<NtfyReceipt> {
    const target = this.targets.get(targetId);
    if (!target) throw new NtfyDeliveryError(`ntfy target is not configured: ${targetId}`, false);
    if (new TextEncoder().encode(envelope.body).byteLength > NTFY_MESSAGE_LIMIT_BYTES) {
      throw new NtfyDeliveryError(
        `ntfy message exceeds the ${NTFY_MESSAGE_LIMIT_BYTES}-byte safety limit`,
        false,
        413,
        false,
        target.id,
      );
    }

    const payload = ntfyPayload(target.topic, envelope);
    let response: Response;
    try {
      response = await this.fetchImpl(target.server_url, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(target.authorization ? { authorization: target.authorization } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch (error) {
      throw new NtfyDeliveryError(
        `ntfy request failed for target ${target.id}: ${safeMessage(error, target)}`,
        true,
        undefined,
        true,
        target.id,
      );
    }

    let raw: string;
    try {
      raw = await readBoundedResponseText(
        response,
        NTFY_RESPONSE_LIMIT_BYTES,
        `ntfy response exceeded ${NTFY_RESPONSE_LIMIT_BYTES} bytes`,
      );
    } catch (error) {
      throw new NtfyDeliveryError(
        `ntfy response failed for target ${target.id}: ${safeMessage(error, target)}`,
        isRetryableStatus(response.status),
        response.status,
        response.ok || isAmbiguousStatus(response.status),
        target.id,
        retryAfter(response),
      );
    }

    const parsed = parseJson(raw);
    if (!response.ok) {
      const structuredRejection = ntfyErrorDetail(parsed);
      const detail = structuredRejection ?? boundedDetail(raw) ?? response.statusText ?? "request rejected";
      throw new NtfyDeliveryError(
        `ntfy publish failed (${response.status}) for target ${target.id}: ${safeMessage(detail, target)}`,
        isRetryableStatus(response.status),
        response.status,
        !structuredRejection && isAmbiguousStatus(response.status),
        target.id,
        retryAfter(response),
      );
    }

    const receipt = parseReceipt(parsed, target, response.status);
    if (!receipt) {
      throw new NtfyDeliveryError(
        `ntfy returned an invalid acceptance receipt (${response.status}) for target ${target.id}`,
        false,
        response.status,
        true,
        target.id,
      );
    }
    return receipt;
  }
}

export class NtfyNotificationAdapter implements NotificationChannelAdapter {
  readonly channel = "ntfy" as const;
  readonly asset_id = "ntfy-notification";

  constructor(private readonly client: NtfyNotificationClient) {}

  async deliver(
    target: NotificationTargetRef,
    envelope: NotificationEnvelopeV1,
  ): Promise<NotificationChannelReceipt> {
    if (target.channel !== this.channel) throw new Error(`ntfy adapter cannot deliver channel ${target.channel}`);
    const receipt = await this.client.publish(target.id, envelope);
    return {
      accepted: true,
      evidence: JSON.stringify({
        channel: this.channel,
        target_id: receipt.target_id,
        topic: receipt.topic,
        message_id: receipt.message_id,
        status: receipt.status,
      }),
    };
  }
}

function ntfyPayload(topic: string, envelope: NotificationEnvelopeV1): Record<string, unknown> {
  const click = envelope.click_url ?? envelope.source?.url;
  return {
    topic,
    title: envelope.title,
    message: envelope.body,
    priority: envelope.priority,
    ...(envelope.tags.length ? { tags: envelope.tags } : {}),
    ...(click ? { click } : {}),
    ...(envelope.image_url ? { icon: envelope.image_url } : {}),
  };
}

function validateTarget(input: NtfyTargetConfig): ValidatedNtfyTargetConfig {
  if (!TARGET_ID.test(input.id)) throw new Error("ntfy target id is invalid");
  if (!TOPIC.test(input.topic)) throw new Error(`ntfy topic is invalid for target ${input.id}`);
  if (input.authorization !== undefined
    && (!input.authorization.trim() || input.authorization.length > 4_096 || /[\r\n]/.test(input.authorization))) {
    throw new Error(`ntfy authorization is invalid for target ${input.id}`);
  }
  return {
    id: input.id,
    topic: input.topic,
    server_url: validateServerUrl(input.server_url),
    ...(input.authorization ? { authorization: input.authorization } : {}),
  };
}

function validateServerUrl(input: string): string {
  let value: URL;
  try { value = new URL(input); }
  catch { throw new Error("ntfy server_url must be a valid URL"); }
  const localHttp = value.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(value.hostname);
  if ((value.protocol !== "https:" && !localHttp) || value.username || value.password
    || value.search || value.hash) {
    throw new Error("ntfy server_url must use HTTPS or loopback HTTP and cannot contain credentials, query, or fragment");
  }
  return value.toString();
}

function parseReceipt(
  value: unknown,
  target: ValidatedNtfyTargetConfig,
  status: number,
): NtfyReceipt | undefined {
  if (!isObject(value) || value.event !== "message" || value.topic !== target.topic
    || typeof value.id !== "string" || !value.id || value.id.length > 128
    || !Number.isInteger(value.time) || Number(value.time) <= 0) return undefined;
  return {
    accepted: true,
    target_id: target.id,
    topic: target.topic,
    message_id: value.id,
    status,
  };
}

function ntfyErrorDetail(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.error === "string" && value.error.trim()) return value.error.slice(0, 1_000);
  if (typeof value.code === "number") return `ntfy error code ${value.code}`;
  return undefined;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { return undefined; }
}

function retryAfter(response: Response): Date | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAmbiguousStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function boundedDetail(value: string): string | undefined {
  const detail = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  return detail ? detail.slice(0, 1_000) : undefined;
}

function safeMessage(error: unknown, target: ValidatedNtfyTargetConfig): string {
  let value = error instanceof Error ? error.message : String(error);
  for (const secret of authorizationSecrets(target.authorization)) {
    value = value.split(secret).join("[redacted]");
  }
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 1_000);
}

function authorizationSecrets(value: string | undefined): string[] {
  if (!value) return [];
  const credential = value.split(/\s+/, 2)[1];
  return [...new Set([value, credential].filter((secret): secret is string => Boolean(secret)))];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
