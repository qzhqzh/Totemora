import type { NotificationDispatchResult } from "./application/notification-dispatcher";
import { parseNotificationEnvelope } from "./domains/notification/notification-envelope";
import type { NotificationTargetRef } from "./domains/notification/notification-target-policy";
import { readBoundedResponseText } from "./integrations/bounded-response";
import { readJson } from "./http/http-boundary";

export class NotifierRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class NotifierClient {
  private readonly base?: string;

  constructor(input: { baseUrl?: string; operatorToken?: string; fetchImpl?: typeof fetch }) {
    if (input.baseUrl) {
      const url = new URL(input.baseUrl);
      const internal = ["localhost", "127.0.0.1", "[::1]", "notifier"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && internal)) || url.username || url.password
        || url.search || url.hash || url.pathname !== "/") throw new Error("Notifier URL must be HTTPS or a local/private service root");
      if (!input.operatorToken || input.operatorToken.length < 32 || input.operatorToken.length > 256) {
        throw new Error("Notifier requires a private operator credential");
      }
      this.base = url.toString();
    }
    this.token = input.operatorToken;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  async dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult> {
    const envelope = parseNotificationEnvelope(input.envelope);
    if (!this.base) return { envelope_id: envelope.id, idempotency_key: envelope.idempotency_key,
      status: "unconfigured", deliveries: [] };
    try {
      const response = await this.fetchImpl(new URL("api/v1/dispatch", this.base), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, ...input, envelope }),
      });
      if (!response.ok) throw new Error(`Notifier dispatch returned HTTP ${response.status}`);
      const data = JSON.parse(await readBoundedResponseText(response, 32_000, "Notifier response too large")) as NotificationDispatchResult;
      if (data.envelope_id !== envelope.id || data.idempotency_key !== envelope.idempotency_key
        || !["completed", "partial", "failed", "uncertain", "unconfigured"].includes(data.status)
        || !Array.isArray(data.deliveries)) throw new Error("Invalid Notifier dispatch receipt");
      return data;
    } catch {
      // The HTTP response may have been lost after a successful channel send.
      return { envelope_id: envelope.id, idempotency_key: envelope.idempotency_key,
        status: "uncertain", deliveries: [] };
    }
  }

  async listTargets(): Promise<NotificationTargetRef[]> {
    if (!this.base) return [];
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("api/v1/targets", this.base), {
        headers: { authorization: `Bearer ${this.token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new NotifierRequestError(503, "Notifier is unavailable"); }
    if (!response.ok) throw new NotifierRequestError(502, "Notifier target lookup failed");
    try {
      const data = JSON.parse(await readBoundedResponseText(response, 32_000, "Notifier response too large")) as { targets: NotificationTargetRef[] };
      if (!Array.isArray(data.targets)) throw new Error("Invalid target response");
      return data.targets;
    } catch { throw new NotifierRequestError(502, "Notifier returned an invalid target response"); }
  }

  async forward(request: Request, operator: boolean): Promise<Response> {
    if (!this.base) throw new NotifierRequestError(503, "Notifier is not configured");
    const url = new URL(request.url);
    const upstream = new URL(`${url.pathname.slice(1)}${url.search}`, this.base);
    let body: string | undefined;
    if (request.method === "POST" && url.pathname === "/api/integrations/notifications/events") {
      body = JSON.stringify(await readJson(request, 16_384));
    }
    let response: Response;
    try {
      response = await this.fetchImpl(upstream, {
        method: request.method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: operator ? `Bearer ${this.token}` : (request.headers.get("authorization") ?? ""),
          ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}),
      });
      const raw = await readBoundedResponseText(response, 2_000_000, "Notifier response too large");
      return new Response(raw, { status: response.status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    } catch { throw new NotifierRequestError(503, "Notifier is unavailable; retry with the same source and id"); }
  }
}
