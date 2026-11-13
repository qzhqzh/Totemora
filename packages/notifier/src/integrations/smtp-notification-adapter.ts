import nodemailer from "nodemailer";

import type { NotificationChannelAdapter } from "../application/notification-dispatcher";
import type { NotificationEnvelopeV1 } from "../domains/notification/notification-envelope";
import type { NotificationTargetRef } from "../domains/notification/notification-target-policy";
import type { NotificationIngressConfig } from "../domains/notification/notification-ingress-contract";

export class SmtpNotificationAdapter implements NotificationChannelAdapter {
  readonly channel = "email" as const;
  readonly asset_id = "smtp-notification";
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(private readonly config: NonNullable<NotificationIngressConfig["smtp"]>,
    private readonly targets: NotificationIngressConfig["email"],
    private readonly sendMail?: (message: {
      from: string; to: string; subject: string; text: string;
      disableFileAccess: true; disableUrlAccess: true;
    }) => Promise<{ accepted: string[]; messageId?: string }>) {
    this.transport = nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.secure,
      requireTLS: !config.secure, auth: { user: config.user, pass: config.password },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
      tls: { rejectUnauthorized: true },
    });
  }

  async deliver(target: NotificationTargetRef, envelope: NotificationEnvelopeV1): Promise<{ accepted: true; evidence: string }> {
    const recipient = this.targets.find((item) => item.id === target.id && item.enabled);
    if (!recipient) throw new Error("Configured email target is unavailable");
    try {
      const message = {
        from: this.config.from, to: recipient.address, subject: envelope.title,
        text: envelope.body, disableFileAccess: true as const, disableUrlAccess: true as const,
      };
      const result = await (this.sendMail ? this.sendMail(message) : this.transport.sendMail(message));
      if (!result.accepted.some((address: string) => address.toLowerCase() === recipient.address.toLowerCase())) {
        throw new Error("SMTP did not confirm recipient acceptance");
      }
      return { accepted: true, evidence: `SMTP accepted ${result.messageId ?? envelope.id}`.slice(0, 400) };
    } catch {
      // A lost SMTP response can mean that DATA was accepted; never auto-replay a possible send.
      throw Object.assign(new Error("SMTP outcome is uncertain; reconcile before retry"), { outcomeUncertain: true });
    }
  }
}
