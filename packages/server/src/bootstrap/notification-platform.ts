import { NotificationDispatcher } from "../application/notification-dispatcher";
import type { NotificationDomain } from "../domains/notification/notification-envelope";
import {
  RefreshingNotificationTargetPolicy,
  type NotificationTargetRef,
} from "../domains/notification/notification-target-policy";
import {
  BarkNotificationAdapter,
  type BarkTargetSender,
} from "../integrations/bark-notification-adapter";
import {
  NtfyNotificationAdapter,
  NtfyNotificationClient,
  type NtfyTargetConfig,
} from "../integrations/ntfy-notification-client";
import {
  TelegramNotificationAdapter,
  type TelegramNotificationTargetConfig,
  type TelegramTextSender,
} from "../integrations/telegram-notification-adapter";

interface PublicBarkTarget {
  id: string;
  label?: string;
  domains: NotificationDomain[];
  enabled: boolean;
}

export interface BarkNotificationCatalog extends BarkTargetSender {
  targets(): Promise<PublicBarkTarget[]>;
}

export interface TelegramPlatformTarget extends TelegramNotificationTargetConfig {
  label?: string;
  domains: NotificationDomain[];
  enabled: boolean;
}

export interface NtfyPlatformTarget extends NtfyTargetConfig {
  label?: string;
  domains: NotificationDomain[];
  enabled: boolean;
}

export interface NotificationPlatformTargetConfiguration {
  telegramTargets: TelegramPlatformTarget[];
  ntfyTargets: NtfyPlatformTarget[];
}

export interface TelegramNotificationCatalog extends TelegramTextSender {
  chatIds(): Promise<string[]>;
}

export interface NotificationPlatformRuntime {
  dispatcher: NotificationDispatcher;
  listTargets(): Promise<NotificationTargetRef[]>;
}

export async function createNotificationPlatform(input: {
  dataDir: string;
  bark: BarkNotificationCatalog;
  telegram: TelegramNotificationCatalog;
  telegramTargets: TelegramPlatformTarget[];
  ntfyTargets: NtfyPlatformTarget[];
  ntfyFetch?: typeof fetch;
}): Promise<NotificationPlatformRuntime> {
  const allowedTelegramChats = new Set(await input.telegram.chatIds());
  const untrustedTelegramTarget = input.telegramTargets.find((target) => !allowedTelegramChats.has(target.chat_id));
  if (untrustedTelegramTarget) {
    throw new Error(`Telegram notification target ${untrustedTelegramTarget.id} is not allowlisted`);
  }
  const configuredTargets = [
    ...input.telegramTargets.map((target): NotificationTargetRef => ({
      id: target.id,
      channel: "telegram",
      domains: [...target.domains],
      enabled: target.enabled,
      ...(target.label ? { label: target.label } : {}),
    })),
    ...input.ntfyTargets.map((target): NotificationTargetRef => ({
      id: target.id,
      channel: "ntfy",
      domains: [...target.domains],
      enabled: target.enabled,
      ...(target.label ? { label: target.label } : {}),
    })),
  ];
  const policy = new RefreshingNotificationTargetPolicy([
    {
      async list() {
        return (await input.bark.targets()).map((target) => ({
          id: target.id,
          channel: "bark" as const,
          domains: [...target.domains],
          enabled: target.enabled,
          ...(target.label ? { label: target.label } : {}),
        }));
      },
    },
    { async list() { return configuredTargets; } },
  ]);
  await policy.list();

  const dispatcher = new NotificationDispatcher(input.dataDir, policy, [
    new BarkNotificationAdapter(input.bark),
    new TelegramNotificationAdapter(input.telegram, input.telegramTargets.map((target) => ({
      id: target.id,
      chat_id: target.chat_id,
    }))),
    new NtfyNotificationAdapter(new NtfyNotificationClient(
      input.ntfyTargets.map((target) => ({
        id: target.id,
        server_url: target.server_url,
        topic: target.topic,
        ...(target.authorization ? { authorization: target.authorization } : {}),
      })),
      input.ntfyFetch,
    )),
  ]);
  return { dispatcher, listTargets: () => policy.list() };
}
