import { createHash } from "node:crypto";

import { ActionJournal, UncertainExternalEffectError } from "../action-journal";
import {
  type NotificationChannel,
  type NotificationEnvelopeV1,
  parseNotificationEnvelope,
} from "../domains/notification/notification-envelope";
import type {
  NotificationTargetPolicy,
  NotificationTargetRef,
} from "../domains/notification/notification-target-policy";

export interface NotificationChannelReceipt {
  accepted: true;
  evidence: string;
}

export interface NotificationChannelAdapter {
  channel: NotificationChannel;
  asset_id: string;
  deliver(target: NotificationTargetRef, envelope: NotificationEnvelopeV1): Promise<NotificationChannelReceipt>;
}

export type NotificationDeliveryStatus = "completed" | "failed" | "uncertain";
export type NotificationDispatchStatus = "completed" | "partial" | "failed" | "uncertain" | "unconfigured";

export interface NotificationDeliveryResult {
  target_id: string;
  channel: NotificationChannel;
  status: NotificationDeliveryStatus;
  replayed?: boolean;
  evidence?: string;
  error?: string;
}

export interface NotificationDispatchResult {
  envelope_id: string;
  idempotency_key: string;
  status: NotificationDispatchStatus;
  deliveries: NotificationDeliveryResult[];
}

export class NotificationDispatcher {
  private readonly adapters = new Map<NotificationChannel, NotificationChannelAdapter>();
  private readonly journal: ActionJournal;

  constructor(
    dataDir: string,
    private readonly policy: NotificationTargetPolicy,
    adapters: NotificationChannelAdapter[],
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.channel)) {
        throw new Error(`Duplicate notification adapter: ${adapter.channel}`);
      }
      this.adapters.set(adapter.channel, adapter);
    }
    this.journal = new ActionJournal(dataDir);
  }

  async dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult> {
    const envelope = parseNotificationEnvelope(input.envelope);
    const memberId = actorId(input.member_id);
    const targets = await this.policy.resolve(envelope);
    if (!targets.length) {
      return {
        envelope_id: envelope.id,
        idempotency_key: envelope.idempotency_key,
        status: "unconfigured",
        deliveries: [],
      };
    }
    const payloadHash = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
    const deliveries = await Promise.all(targets.map((target) => this.deliver(
      envelope,
      memberId,
      target,
      payloadHash,
    )));
    return {
      envelope_id: envelope.id,
      idempotency_key: envelope.idempotency_key,
      status: aggregateStatus(deliveries),
      deliveries,
    };
  }

  private async deliver(
    envelope: NotificationEnvelopeV1,
    memberId: string,
    target: NotificationTargetRef,
    payloadHash: string,
  ): Promise<NotificationDeliveryResult> {
    const adapter = this.adapters.get(target.channel);
    if (!adapter) return failure(target, "failed", `Notification adapter is not configured: ${target.channel}`);
    try {
      const result = await this.journal.executeEffectOnce({
        idempotency_key: `notification:${envelope.idempotency_key}:${target.channel}:${target.id}`,
        asset_id: adapter.asset_id,
        member_id: memberId,
        action: "push_notification",
        request: {
          schema_version: envelope.schema_version,
          envelope_id: envelope.id,
          domain: envelope.domain,
          channel: target.channel,
          target_id: target.id,
          payload_hash: payloadHash,
        },
      }, async () => {
        const receipt = await adapter.deliver(target, envelope);
        if (receipt.accepted !== true || !receipt.evidence.trim()) {
          throw Object.assign(new Error("Notification target returned an invalid acceptance receipt"), {
            outcomeUncertain: true,
          });
        }
        return receipt.evidence;
      });
      return {
        target_id: target.id,
        channel: target.channel,
        status: "completed",
        replayed: result.replayed,
        evidence: result.record.evidence,
      };
    } catch (error) {
      return failure(
        target,
        error instanceof UncertainExternalEffectError ? "uncertain" : "failed",
        safeError(error),
      );
    }
  }
}

function aggregateStatus(deliveries: NotificationDeliveryResult[]): NotificationDispatchStatus {
  const completed = deliveries.filter((delivery) => delivery.status === "completed").length;
  if (completed === deliveries.length) return "completed";
  if (deliveries.some((delivery) => delivery.status === "uncertain")) return "uncertain";
  if (completed > 0) return "partial";
  return "failed";
}

function failure(
  target: NotificationTargetRef,
  status: "failed" | "uncertain",
  error: string,
): NotificationDeliveryResult {
  return { target_id: target.id, channel: target.channel, status, error };
}

function actorId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Notification member_id must be a stable identifier");
  }
  return value;
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 500);
}
