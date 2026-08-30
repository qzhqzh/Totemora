export type CodexScheduledSubscriptionStatus = "active" | "revoked";
export type CodexScheduledDeliveryStatus = "never" | "delivered" | "failed" | "uncertain";

export interface CodexScheduledSubscription {
  id: string;
  name: string;
  target_chat_id: string;
  status: CodexScheduledSubscriptionStatus;
  last_run_key?: string;
  last_delivery_status: CodexScheduledDeliveryStatus;
  last_delivered_at?: string;
  last_error?: string;
  revision: number;
  created_at: string;
  updated_at: string;
  revoked_at?: string;
}

export interface CodexScheduledDigest {
  run_key: string;
  title: string;
  body: string;
  source_urls?: string[];
  occurred_at?: string;
}

export const CODEX_SCHEDULED_SUBSCRIPTION_LIMIT = 3;
