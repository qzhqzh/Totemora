export interface NotificationIngressConfig {
  operator_token?: string;
  sources: Array<{ id: string; token: string }>;
  bark?: Array<{
    id: string; device_key: string; server_url: string; authorization?: string;
    domains: Array<"ai" | "finance" | "reminder" | "deals" | "forwarded" | "content" | "ops">;
    enabled: boolean; label?: string;
  }>;
  telegram_bot_token?: string;
  rules: Array<{
    id: string;
    source: string;
    type_prefix: string;
    targets: string[];
    coalesce_window_seconds: number;
  }>;
  email: Array<{ id: string; address: string; enabled: boolean }>;
  smtp?: { host: string; port: number; secure: boolean; user: string; password: string; from: string };
}
