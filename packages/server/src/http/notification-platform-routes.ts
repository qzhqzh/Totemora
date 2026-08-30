import { createHash } from "node:crypto";

import type {
  NotificationDispatchResult,
} from "../application/notification-dispatcher";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DOMAINS,
  type NotificationChannel,
  type NotificationDomain,
} from "../domains/notification/notification-envelope";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";
import { HttpError, json, readJson } from "./http-boundary";
import { inputObject, optionalEnum, optionalStringArray, requiredString } from "./input-schema";

export interface NotificationPlatformRouteService {
  listTargets(): Promise<NotificationTargetRef[]>;
  dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult>;
}

export interface NotificationPlatformRouteDependencies {
  service: NotificationPlatformRouteService;
  requireOperator(request: Request): void;
}

export async function handleNotificationPlatformRoutes(
  request: Request,
  url: URL,
  dependencies: NotificationPlatformRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/notifications/platform")) return undefined;
  dependencies.requireOperator(request);

  if (request.method === "GET" && url.pathname === "/api/notifications/platform") {
    const targets = await dependencies.service.listTargets();
    return json({
      schema_version: 1,
      state: targets.some((target) => target.enabled) ? "configured" : "unconfigured",
      supported_domains: NOTIFICATION_DOMAINS,
      supported_channels: NOTIFICATION_CHANNELS,
      targets,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/notifications/platform/test") {
    const input = platformTestInput(await readJson(request, 8_000));
    const digest = createHash("sha256").update(input.idempotency_key).digest("hex").slice(0, 24);
    return json(await dependencies.service.dispatch({
      member_id: "operator",
      envelope: {
        schema_version: 1,
        id: `notification-test:${digest}`,
        idempotency_key: `operator-test:${input.idempotency_key}`,
        domain: input.domain,
        kind: "status",
        title: "Totemora 通知通道测试",
        body: `Operator 已验证 ${input.domain} 领域通过 ${input.target_channels.join("、")} 通道的统一派发链路。`,
        priority: 3,
        tags: ["white_check_mark", "test"],
        target_channels: input.target_channels,
      },
    }));
  }
  return undefined;
}

function platformTestInput(value: unknown): {
  domain: NotificationDomain;
  target_channels: NotificationChannel[];
  idempotency_key: string;
} {
  const input = inputObject(value);
  const unknown = Object.keys(input).find((key) => !["domain", "target_channels", "idempotency_key"].includes(key));
  if (unknown) throw new HttpError(400, `Unsupported notification test field: ${unknown}`);
  const domain = optionalEnum(input.domain, "domain", NOTIFICATION_DOMAINS);
  if (!domain) throw new HttpError(400, "domain is required");
  const channels = optionalStringArray(input.target_channels, "target_channels", NOTIFICATION_CHANNELS.length, 20);
  if (!channels?.length || channels.some((channel) => !NOTIFICATION_CHANNELS.includes(channel as NotificationChannel))) {
    throw new HttpError(400, `target_channels must contain 1-${NOTIFICATION_CHANNELS.length} of ${NOTIFICATION_CHANNELS.join(", ")}`);
  }
  const targetChannels = [...new Set(channels)] as NotificationChannel[];
  const idempotencyKey = requiredString(input.idempotency_key, "idempotency_key", 180);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(idempotencyKey)) {
    throw new HttpError(400, "idempotency_key must be a stable ASCII key");
  }
  return { domain, target_channels: targetChannels, idempotency_key: idempotencyKey };
}
