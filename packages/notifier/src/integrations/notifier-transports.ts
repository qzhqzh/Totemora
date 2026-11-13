import type { NotificationIngressConfig } from "../domains/notification/notification-ingress-contract";
import type { BarkTargetSender } from "./bark-notification-adapter";
import type { TelegramTextSender } from "./telegram-notification-adapter";
import { readBoundedResponseText } from "./bounded-response";

/** Credentials and destinations live only in the Notifier's private config. */
export class NotifierBarkSender implements BarkTargetSender {
  constructor(private readonly configured: NonNullable<NotificationIngressConfig["bark"]>,
    private readonly fetchImpl: typeof fetch = fetch) {}

  async pushTo(targetId: string, message: { title: string; body: string; id?: string; url?: string }) {
    const target = this.configured.find((item) => item.id === targetId && item.enabled);
    if (!target) throw new Error("Bark target is unavailable");
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("push", `${target.server_url.replace(/\/+$/, "")}/`), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", ...(target.authorization ? { authorization: target.authorization } : {}) },
        body: JSON.stringify({ device_key: target.device_key, title: message.title,
          body: message.body, ...(message.id ? { id: message.id } : {}), ...(message.url ? { url: message.url } : {}) }),
      });
    } catch {
      throw Object.assign(new Error("Bark network result is unknown"), { outcomeUncertain: true });
    }
    if (!response.ok) throw deliveryHttpError("Bark", response.status);
    return { target_id: target.id, status: response.status, accepted: true as const };
  }

  async targets() {
    return this.configured.map(({ id, domains, enabled, label }) => ({ id, domains, enabled, ...(label ? { label } : {}) }));
  }
}

export class NotifierTelegramSender implements TelegramTextSender {
  constructor(private readonly token: string, private readonly allowedChatIds: string[],
    private readonly fetchImpl: typeof fetch = fetch) {}

  async chatIds(): Promise<string[]> { return [...this.allowedChatIds]; }

  async sendText(chatId: string | number, text: string): Promise<{ message_id: number; chat_id: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch {
      throw Object.assign(new Error("Telegram network result is unknown"), { outcomeUncertain: true });
    }
    if (!response.ok) throw deliveryHttpError("Telegram", response.status);
    try {
      const raw = await readBoundedResponseText(response, 8192, "Telegram response too large");
      const receipt = JSON.parse(raw) as { ok?: boolean; result?: { message_id?: number; chat?: { id?: number } } };
      if (receipt.ok && Number.isInteger(receipt.result?.message_id)
        && String(receipt.result?.chat?.id) === String(chatId)) {
        return { message_id: receipt.result!.message_id!, chat_id: String(chatId) };
      }
    } catch {}
    throw Object.assign(new Error("Telegram acceptance receipt is unknown"), { outcomeUncertain: true });
  }
}

function deliveryHttpError(channel: string, status: number): Error {
  // A proxy timeout or server error can arrive after downstream acceptance.
  // Only definite rejection permits replay of the same notification.
  if (status === 408 || status >= 500) {
    return Object.assign(new Error(`${channel} delivery outcome is unknown (HTTP ${status})`), { outcomeUncertain: true });
  }
  return new Error(`${channel} rejected delivery (HTTP ${status})`);
}
