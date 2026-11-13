import type {
  NotificationChannel,
  NotificationDomain,
  NotificationEnvelopeV1,
} from "./notification-envelope";
import { NOTIFICATION_CHANNELS, NOTIFICATION_DOMAINS } from "./notification-envelope";

export interface NotificationTargetRef {
  id: string;
  channel: NotificationChannel;
  domains: NotificationDomain[];
  enabled: boolean;
  label?: string;
}

export interface NotificationTargetPolicy {
  resolve(envelope: NotificationEnvelopeV1): Promise<NotificationTargetRef[]>;
  list(): Promise<NotificationTargetRef[]>;
}

export interface NotificationTargetSource {
  list(): Promise<NotificationTargetRef[]>;
}

const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class StaticNotificationTargetPolicy implements NotificationTargetPolicy {
  private readonly targets: NotificationTargetRef[];

  constructor(input: NotificationTargetRef[]) {
    this.targets = normalizeTargets(input);
  }

  async resolve(envelope: NotificationEnvelopeV1): Promise<NotificationTargetRef[]> {
    const requested = envelope.target_channels ? new Set(envelope.target_channels) : undefined;
    return this.targets
      .filter((target) => target.enabled
        && target.domains.includes(envelope.domain)
        && (!requested || requested.has(target.channel)))
      .map((target) => structuredClone(target));
  }

  async list(): Promise<NotificationTargetRef[]> {
    return this.targets.map((target) => structuredClone(target));
  }
}

export class RefreshingNotificationTargetPolicy implements NotificationTargetPolicy {
  constructor(private readonly sources: NotificationTargetSource[]) {
    if (!sources.length) throw new Error("Refreshing notification target policy requires at least one source");
  }

  async resolve(envelope: NotificationEnvelopeV1): Promise<NotificationTargetRef[]> {
    const requested = envelope.target_channels ? new Set(envelope.target_channels) : undefined;
    return (await this.list()).filter((target) => target.enabled
      && target.domains.includes(envelope.domain)
      && (!requested || requested.has(target.channel)));
  }

  async list(): Promise<NotificationTargetRef[]> {
    const targetGroups = await Promise.all(this.sources.map((source) => source.list()));
    return normalizeTargets(targetGroups.flat());
  }
}

function normalizeTargets(input: NotificationTargetRef[]): NotificationTargetRef[] {
  const seen = new Set<string>();
  return input.map((target) => {
    validateTarget(target);
    const key = `${target.channel}:${target.id}`;
    if (seen.has(key)) throw new Error(`Duplicate notification target: ${key}`);
    seen.add(key);
    return structuredClone(target);
  });
}

function validateTarget(target: NotificationTargetRef): void {
  if (!TARGET_ID.test(target.id)) throw new Error("Notification target id is invalid");
  if (!NOTIFICATION_CHANNELS.includes(target.channel)) {
    throw new Error(`Unsupported notification channel: ${target.channel}`);
  }
  if (!Array.isArray(target.domains) || !target.domains.length) {
    throw new Error(`Notification target ${target.id} must have at least one domain`);
  }
  if (target.domains.some((domain) => !NOTIFICATION_DOMAINS.includes(domain))) {
    throw new Error(`Notification target ${target.id} has an unsupported domain`);
  }
  if (typeof target.enabled !== "boolean") throw new Error(`Notification target ${target.id} enabled must be boolean`);
  if (target.label !== undefined && (!target.label.trim() || target.label.length > 80)) {
    throw new Error(`Notification target ${target.id} label must contain 1-80 characters`);
  }
}
