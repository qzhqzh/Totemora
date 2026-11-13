import { createHash } from "node:crypto";

import { ActionJournal } from "../action-journal";
import type { NotificationPlatformRuntime } from "../bootstrap/notification-platform";
import { NOTIFICATION_CHANNELS, NOTIFICATION_DOMAINS } from "../domains/notification/notification-envelope";
import { NotifierDatabase } from "../storage";
import { HttpError, json, readJson } from "./http-boundary";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function handleNotifierOperatorRoutes(input: {
  request: Request; url: URL; requireOperator: (request: Request) => void;
  platform: NotificationPlatformRuntime; dataDir: string;
}): Promise<Response | undefined> {
  const { request, url, platform, dataDir } = input;
  if (url.pathname === "/api/v1/status" && request.method === "GET") {
    input.requireOperator(request);
    const db = NotifierDatabase.open(dataDir).db;
    const events = db.query("SELECT status,count(*) AS count FROM external_notification_events GROUP BY status").all();
    const deliveries = db.query("SELECT status,count(*) AS count FROM action_journal WHERE idempotency_key LIKE 'notification:%' GROUP BY status").all();
    return json({ schema_version: 1, events, deliveries });
  }
  if (url.pathname === "/api/v1/deliveries" && request.method === "GET") {
    input.requireOperator(request);
    const limit = url.searchParams.get("limit") ?? "25";
    const key = url.searchParams.get("idempotency_key") ?? undefined;
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new HttpError(400, "limit must be 1-100");
    if (key !== undefined && !KEY.test(key)) throw new HttpError(400, "Invalid idempotency_key");
    return json({ deliveries: new ActionJournal(dataDir).recent(Number(limit), key) });
  }
  if (url.pathname !== "/api/v1/test" || request.method !== "POST") return undefined;
  input.requireOperator(request);
  const raw = await readJson(request, 2_000);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Invalid test request");
  const data = raw as Record<string, unknown>;
  if (data.schema_version !== 1 || Object.keys(data).some((field) => ![
    "schema_version", "domain", "channel", "target_id", "idempotency_key",
  ].includes(field)) || !NOTIFICATION_DOMAINS.includes(data.domain as typeof NOTIFICATION_DOMAINS[number])
    || !NOTIFICATION_CHANNELS.includes(data.channel as typeof NOTIFICATION_CHANNELS[number])
    || typeof data.target_id !== "string" || !TARGET.test(data.target_id)
    || typeof data.idempotency_key !== "string" || !KEY.test(data.idempotency_key)) {
    throw new HttpError(400, "Invalid test request");
  }
  const target = (await platform.listTargets()).find((item) => item.channel === data.channel
    && item.id === data.target_id && item.enabled && item.domains.includes(data.domain as typeof item.domains[number]));
  if (!target) throw new HttpError(409, "Target is unavailable or does not accept this domain");
  const key = `operator-test:${data.idempotency_key}`;
  const id = `operator-test:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  return json(await platform.dispatcher.dispatch({ member_id: "notifier-operator",
    allowed_targets: [`${target.channel}:${target.id}`], envelope: {
      schema_version: 1, id, idempotency_key: key, domain: data.domain, kind: "status",
      title: "[Notifier 测试] 投递链路检查",
      body: `这是 Notifier 的固定测试消息。目标：${target.channel}:${target.id}；测试编号：${data.idempotency_key}。`,
      priority: 3, tags: ["notifier-test"], target_channels: [target.channel],
    },
  }));
}
