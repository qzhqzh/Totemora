import { createHash, timingSafeEqual } from "node:crypto";

import type { NotificationDispatchResult } from "./notification-dispatcher";
import type { NotificationIngressConfig } from "../domains/notification/notification-ingress-contract";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";
import {
  ExternalNotificationInputError, parseExternalNotificationEvent, readExternalEventSource,
} from "../domains/notification/external-event";
import {
  ExternalNotificationRepository, type ExternalEventStatus, type StoredExternalNotificationEvent,
} from "../repositories/external-notification-repository";

interface ExternalNotificationDispatcher {
  dispatch(input: { envelope: unknown; member_id: string; allowed_targets?: string[] }): Promise<NotificationDispatchResult>;
}

export class ExternalNotificationAuthorizationError extends Error {}

export class ExternalNotificationService {
  private readonly repository: ExternalNotificationRepository;

  constructor(dataDir: string, private readonly config: NotificationIngressConfig,
    private readonly dispatcher: ExternalNotificationDispatcher,
    private readonly listTargets: () => Promise<NotificationTargetRef[]>) {
    this.repository = new ExternalNotificationRepository(dataDir);
  }

  async accept(input: unknown, authorization: string | null): Promise<{
    event_uuid: string; source: string; id: string; status: ExternalEventStatus; duplicate: boolean;
  }> {
    const source = readExternalEventSource(input);
    this.authorize(source, authorization);
    const event = parseExternalNotificationEvent(input);
    const previous = this.repository.findDuplicate(event);
    if (previous) {
      return { event_uuid: previous.event_uuid, source, id: previous.id, status: previous.status, duplicate: true };
    }
    const rule = this.config.rules.find((item) =>
      (item.source === "*" || item.source === source) && event.type.startsWith(item.type_prefix));
    const available = rule ? await this.listTargets() : [];
    const active = new Set(available.filter((target) => target.enabled && target.domains.includes("ops"))
      .map((target) => `${target.channel}:${target.id}`));
    const allAvailable = rule?.targets.every((target) => active.has(target)) ?? false;
    const { event: stored, duplicate } = this.repository.accept({
      event, targets: rule && allAvailable ? rule.targets : [],
      coalesce_window_seconds: rule?.coalesce_window_seconds ?? 0,
      ...(!rule ? { unrouted_reason: "No routing rule matched" }
        : !allAvailable ? { unrouted_reason: "Configured target is unavailable" } : {}),
    });
    return { event_uuid: stored.event_uuid, source, id: stored.id, status: stored.status, duplicate };
  }

  list(status: ExternalEventStatus | "all", limit: number): StoredExternalNotificationEvent[] {
    return this.repository.list(status, limit);
  }

  get(id: string): StoredExternalNotificationEvent | undefined { return this.repository.get(id); }

  retryFailed(id: string): StoredExternalNotificationEvent {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ExternalNotificationInputError("event_uuid is invalid");
    return this.repository.retryFailed(id);
  }

  async runDue(): Promise<{ claimed: number; completed: number; failed: number; uncertain: number }> {
    this.repository.recoverStaleSending();
    const batch = this.repository.claim(20);
    const summary = { claimed: batch.length, completed: 0, failed: 0, uncertain: 0 };
    for (const event of batch) {
      let active: Set<string>;
      try {
        active = new Set((await this.listTargets())
          .filter((target) => target.enabled && target.domains.includes("ops"))
          .map((target) => `${target.channel}:${target.id}`));
      } catch {
        this.repository.finish(event.event_uuid, "uncertain");
        summary.uncertain += 1;
        continue;
      }
      if (!event.route_targets.every((target) => active.has(target))) {
        this.repository.finish(event.event_uuid, "unrouted");
        continue;
      }
      let result: NotificationDispatchResult;
      try {
        result = await this.dispatcher.dispatch({ member_id: "notification-ingress",
          allowed_targets: event.route_targets, envelope: {
          schema_version: 1,
          id: `external:${event.event_uuid}`,
          idempotency_key: `external:${createHash("sha256")
            .update(JSON.stringify([event.source, event.id])).digest("hex")}`,
          domain: "ops", kind: "status", title: event.title, body: event.body,
          priority: event.priority, tags: ["external", "ops"],
          source: { source_id: event.source, occurred_at: event.occurred_at },
        } });
      } catch {
        // The dispatcher may have sent before it failed; a definite retry would risk duplicate delivery.
        this.repository.finish(event.event_uuid, "uncertain");
        summary.uncertain += 1;
        continue;
      }
      const delivered = new Set(result.deliveries.map((item) => `${item.channel}:${item.target_id}`));
      const missing = event.route_targets.some((target) => !delivered.has(target));
      const status = result.status === "completed" && !missing ? "completed"
        : result.status === "unconfigured" ? "unrouted"
          : result.status === "uncertain" ? "uncertain" : "failed";
      this.repository.finish(event.event_uuid, status, result);
      if (status === "completed") summary.completed += 1;
      else if (status === "failed") summary.failed += 1;
      else if (status === "uncertain") summary.uncertain += 1;
    }
    return summary;
  }

  private authorize(source: string, authorization: string | null): void {
    const token = authorization?.match(/^Bearer ([^\s]{32,256})$/)?.[1];
    const configured = this.config.sources.find((item) => item.id === source);
    if (!token || !configured) throw new ExternalNotificationAuthorizationError("Unknown notification source or credential");
    const received = createHash("sha256").update(token).digest();
    const expected = createHash("sha256").update(configured.token).digest();
    if (!timingSafeEqual(received, expected)) throw new ExternalNotificationAuthorizationError("Unknown notification source or credential");
  }
}
