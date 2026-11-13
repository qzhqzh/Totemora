import { createHmac } from "node:crypto";

import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";
import type { NotificationIngressConfig } from "../domains/notification/notification-ingress-contract";
import type { NotificationPlatformTargetConfiguration } from "./notification-platform";

/** Operator-only stable destination identifiers; never return a full key, chat ID or address. */
export function withDestinationHints(
  targets: NotificationTargetRef[], ingress: NotificationIngressConfig,
  configured: NotificationPlatformTargetConfiguration,
) {
  return targets.map((target) => {
    let destination: string | undefined;
    let serverHost: string | undefined;
    if (target.channel === "bark") {
      const item = ingress.bark?.find((row) => row.id === target.id);
      destination = item?.device_key;
      serverHost = item ? new URL(item.server_url).hostname : undefined;
    } else if (target.channel === "telegram") {
      destination = configured.telegramTargets.find((row) => row.id === target.id)?.chat_id;
    } else if (target.channel === "ntfy") {
      const item = configured.ntfyTargets.find((row) => row.id === target.id);
      destination = item ? `${item.server_url}|${item.topic}` : undefined;
      serverHost = item ? new URL(item.server_url).hostname : undefined;
    } else if (target.channel === "email") {
      destination = ingress.email.find((row) => row.id === target.id)?.address.toLowerCase();
    }
    return { ...target,
      ...(destination && ingress.operator_token ? { destination_fingerprint: createHmac("sha256", ingress.operator_token)
        .update(`${target.channel}:`).update(destination).digest("hex").slice(0, 12) } : {}),
      ...(serverHost ? { server_host: serverHost } : {}),
    };
  });
}
