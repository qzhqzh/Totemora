import type {
  NotificationChannelAdapter,
  NotificationChannelReceipt,
} from "../application/notification-dispatcher";
import type { NotificationEnvelopeV1 } from "../domains/notification/notification-envelope";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";

interface BarkPushReceipt {
  target_id: string;
  status: number;
  accepted: true;
}

export interface BarkTargetSender {
  pushTo(targetId: string, message: {
    title: string;
    body: string;
    url?: string;
    id?: string;
  }): Promise<BarkPushReceipt>;
}

export class BarkNotificationAdapter implements NotificationChannelAdapter {
  readonly channel = "bark" as const;
  readonly asset_id = "bark-notification";

  constructor(private readonly service: BarkTargetSender) {}

  async deliver(
    target: NotificationTargetRef,
    envelope: NotificationEnvelopeV1,
  ): Promise<NotificationChannelReceipt> {
    if (target.channel !== this.channel) throw new Error(`Bark adapter cannot deliver channel ${target.channel}`);
    const receipt = await this.service.pushTo(target.id, {
      title: envelope.title,
      body: envelope.body,
      id: envelope.id,
      ...(notificationUrl(envelope) ? { url: notificationUrl(envelope) } : {}),
    });
    if (receipt.accepted !== true || receipt.target_id !== target.id
      || !Number.isInteger(receipt.status) || receipt.status < 200 || receipt.status >= 300) {
      throw Object.assign(new Error(`Bark returned an invalid acceptance receipt for target ${target.id}`), {
        outcomeUncertain: true,
      });
    }
    return {
      accepted: true,
      evidence: JSON.stringify({
        channel: this.channel,
        target_id: target.id,
        status: receipt.status,
      }),
    };
  }
}

function notificationUrl(envelope: NotificationEnvelopeV1): string | undefined {
  return envelope.click_url ?? envelope.source?.url;
}
