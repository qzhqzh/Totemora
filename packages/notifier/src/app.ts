import { createHash, timingSafeEqual } from "node:crypto";

import { ExternalNotificationService } from "./application/external-notification-service";
import { AdminConfigConflictError, AdminConfigStore } from "./bootstrap/admin-config-store";
import { createNotificationPlatform, type NotificationPlatformTargetConfiguration } from "./bootstrap/notification-platform";
import { withDestinationHints } from "./bootstrap/notification-destination-hints";
import { NotificationIngressConfigError } from "./bootstrap/notification-ingress-config";
import type { NotificationIngressConfig } from "./domains/notification/notification-ingress-contract";
import { NotificationEnvelopeValidationError } from "./domains/notification/notification-envelope";
import { handleExternalNotificationRoutes } from "./http/external-notification-routes";
import { handleNotifierOperatorRoutes } from "./http/notifier-operator-routes";
import { adminAsset } from "./http/admin-assets";
import { handleAdminManagementRoutes } from "./http/admin-management-routes";
import { AdminSessions } from "./http/admin-sessions";
import { HttpError, json, readJson } from "./http/http-boundary";
import { NotifierBarkSender, NotifierTelegramSender } from "./integrations/notifier-transports";
import { NotifierDatabase } from "./storage";

export async function createNotifierApp(input: {
  dataDir: string;
  config: NotificationIngressConfig;
  targets: NotificationPlatformTargetConfiguration;
  operatorToken: string;
  fetchImpl?: typeof fetch;
}) {
  if (input.targets.telegramTargets.length && !input.config.telegram_bot_token) {
    throw new Error("Telegram targets require a Notifier telegram_bot_token");
  }
  const store = await AdminConfigStore.open(input.dataDir, { ...input.config, operator_token: input.operatorToken });
  const build = async (config: NotificationIngressConfig) => {
    const platform = await createNotificationPlatform({
      dataDir: input.dataDir,
      bark: new NotifierBarkSender(config.bark ?? [], input.fetchImpl),
      telegram: new NotifierTelegramSender(config.telegram_bot_token ?? "",
        input.targets.telegramTargets.map((target) => target.chat_id), input.fetchImpl),
      telegramTargets: input.targets.telegramTargets, ntfyTargets: input.targets.ntfyTargets,
      ntfyFetch: input.fetchImpl, ingress: config,
    });
    return { platform, inbox: new ExternalNotificationService(input.dataDir, config,
      platform.dispatcher, platform.listTargets), config };
  };
  let current = await build(store.config);
  const sessions = new AdminSessions(input.operatorToken);
  const requireOperator = (request: Request) => {
    const supplied = request.headers.get("authorization")?.match(/^Bearer ([^\s]{32,256})$/)?.[1];
    if (!supplied || !constantEqual(supplied, input.operatorToken)) throw new HttpError(401, "Operator credential required");
  };
  return {
    runDue: () => current.inbox.runDue(),
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/healthz" && request.method === "GET") {
          NotifierDatabase.open(input.dataDir).db.query("SELECT 1").get();
          return json({ status: "ok" });
        }
        const asset = await adminAsset(url.pathname, request.method);
        if (asset) return asset;
        const sessionResponse = await sessions.route(request, url);
        if (sessionResponse) return sessionResponse;
        if (url.pathname.startsWith("/admin/api/")) {
          sessions.require(request, url);
          const managed = await handleAdminManagementRoutes({ request, url, store, targets: input.targets,
            listTargets: current.platform.listTargets,
            update: (revision, change) => store.update(revision, change, build,
              (_config, prepared) => { current = prepared; }),
          });
          if (managed) return managed;
          const mapped = adminOperatorUrl(url);
          if (mapped) {
            const forwarded = new Request(mapped, { method: request.method, headers: request.headers,
              body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
              duplex: "half" } as RequestInit);
            const externalAdmin = await handleExternalNotificationRoutes(forwarded, mapped, current.inbox, () => {});
            if (externalAdmin) return externalAdmin;
            const operatorAdmin = await handleNotifierOperatorRoutes({ request: forwarded,
              url: mapped, platform: current.platform, dataDir: input.dataDir, requireOperator: () => {} });
            if (operatorAdmin) return operatorAdmin;
          }
          return json({ error: "Not found" }, 404);
        }
        const external = await handleExternalNotificationRoutes(request, url, current.inbox, requireOperator);
        if (external) return external;
        const operator = await handleNotifierOperatorRoutes({
          request, url, platform: current.platform, dataDir: input.dataDir, requireOperator,
        });
        if (operator) return operator;
        if (url.pathname === "/api/v1/targets" && request.method === "GET") {
          requireOperator(request);
          return json({ schema_version: 1, targets: withDestinationHints(
            await current.platform.listTargets(), current.config, input.targets,
          ) });
        }
        if (url.pathname === "/api/v1/dispatch" && request.method === "POST") {
          requireOperator(request);
          const payload = await readJson(request, 20_000);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(400, "Invalid dispatch request");
          const record = payload as Record<string, unknown>;
          if (record.schema_version !== 1 || Object.keys(record).some((key) => !["schema_version", "member_id", "envelope"].includes(key))
            || typeof record.member_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.member_id)) {
            throw new HttpError(400, "Invalid dispatch request");
          }
          return json(await current.platform.dispatcher.dispatch({ envelope: record.envelope, member_id: record.member_id }));
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        const status = error instanceof HttpError ? error.status
          : error instanceof AdminConfigConflictError ? 409
          : error instanceof NotificationIngressConfigError ? 400
          : error instanceof NotificationEnvelopeValidationError ? 400 : 500;
        return json({ error: status === 500 ? "Notifier request failed" : (error as Error).message }, status);
      }
    },
  };
}

function adminOperatorUrl(url: URL): URL | undefined {
  let path = url.pathname.slice("/admin".length);
  if (path === "/api/status" || path === "/api/deliveries" || path === "/api/test") {
    path = `/api/v1${path.slice(4)}`;
  } else if (path === "/api/events" || path.startsWith("/api/events/")) {
    path = `/api/notifications${path.slice(4)}`;
  } else { return undefined; }
  const mapped = new URL(url);
  mapped.pathname = path;
  return mapped;
}

function constantEqual(a: string, b: string): boolean {
  const actual = createHash("sha256").update(a).digest();
  const expected = createHash("sha256").update(b).digest();
  return timingSafeEqual(actual, expected);
}
