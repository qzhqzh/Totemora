import type { ContentWork } from "../content-studio-service";
import {
  ContentNotificationRepository,
  type ContentNotificationRecord,
} from "../repositories/content-notification-repository";
import type { NotificationDispatchResult } from "./notification-dispatcher";

export interface ContentNotificationDispatcher {
  dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult>;
}

export interface ContentNotificationOutcome {
  attempted: boolean;
  changed: boolean;
  record: ContentNotificationRecord;
}

const TERMINAL = new Set(["completed", "uncertain", "suppressed"]);
const BODY_LIMIT_BYTES = 3_600;

export class ContentNotificationService {
  private readonly repository: ContentNotificationRepository;
  private readonly clock: () => Date;
  private readonly cutoverAt: string;

  constructor(private readonly input: {
    dataDir: string;
    dispatcher: ContentNotificationDispatcher;
    now?: () => Date;
  }) {
    this.repository = new ContentNotificationRepository(input.dataDir);
    this.clock = input.now ?? (() => new Date());
    this.cutoverAt = this.repository.ensureCutover(this.clock().toISOString());
  }

  status(workId: string): ContentNotificationRecord | undefined {
    return this.repository.get(workId);
  }

  dueWorkIds(now = this.clock()): string[] {
    return this.repository.dueScheduledWorkIds(now.toISOString());
  }

  async notify(work: ContentWork, now = this.clock()): Promise<ContentNotificationOutcome> {
    requireReadyWork(work);
    const existing = this.repository.get(work.id);
    if (existing && TERMINAL.has(existing.status)) return { attempted: false, changed: false, record: existing };
    if (!existing && Date.parse(work.updated_at) < Date.parse(this.cutoverAt)) {
      return {
        attempted: false,
        changed: true,
        record: this.repository.suppress(
          work.id, "Ready before scheduled content notification cutover", now.toISOString(),
        ),
      };
    }
    if (existing?.status === "failed" && existing.retry_after
      && Date.parse(existing.retry_after) > now.getTime()) {
      return { attempted: false, changed: false, record: existing };
    }

    const timestamp = now.toISOString();
    const pending = this.repository.begin(work.id, timestamp);
    try {
      const result = await this.input.dispatcher.dispatch({
        member_id: "content.studio",
        envelope: contentEnvelope(work),
      });
      const status = result.status === "completed" ? "completed"
        : result.status === "uncertain" ? "uncertain" : "failed";
      const record = this.repository.finish({
        record: pending,
        status,
        now: timestamp,
        dispatch_result: result,
        ...(status === "failed" ? {
          last_error: dispatchFailure(result),
          retry_after: retryAfter(pending.attempts, now),
        } : {}),
      });
      return { attempted: true, changed: true, record };
    } catch (error) {
      const record = this.repository.finish({
        record: pending,
        status: "failed",
        now: timestamp,
        last_error: error instanceof Error ? error.message : String(error),
        retry_after: retryAfter(pending.attempts, now),
      });
      return { attempted: true, changed: true, record };
    }
  }
}

function contentEnvelope(work: ContentWork): unknown {
  const headline = singleLine(work.title ?? work.topic, 168);
  const sourceUrl = httpsUrl(work.source.url);
  return {
    schema_version: 1,
    id: `content-draft-${work.id}`,
    idempotency_key: `content:draft:${work.id}`,
    domain: "content",
    kind: "draft",
    title: `内容草稿已就绪｜${headline}`,
    body: truncateUtf8(work.body!, BODY_LIMIT_BYTES),
    priority: 3,
    tags: ["writing_hand", "content"],
    source: {
      source_id: work.source.candidate_id ?? work.id,
      ...(sourceUrl ? { url: sourceUrl } : {}),
      occurred_at: work.created_at,
    },
    ...(sourceUrl ? { click_url: sourceUrl } : {}),
  };
}

function requireReadyWork(work: ContentWork): void {
  if (work.status !== "ready" || !work.body?.trim()) {
    throw new Error("Only ready content with a body can be notified");
  }
}

function retryAfter(attempts: number, now: Date): string {
  const minutes = Math.min(60, 5 * (2 ** Math.min(4, Math.max(0, attempts - 1))));
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function dispatchFailure(result: NotificationDispatchResult): string {
  if (result.status === "unconfigured") return "No notification target is configured for content";
  const failed = result.deliveries.filter((item) => item.status !== "completed")
    .map((item) => `${item.channel}:${item.target_id}:${item.status}`);
  return failed.join(", ") || `Content notification dispatch ${result.status}`;
}

function singleLine(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum) || "未命名内容";
}

function httpsUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString() : undefined;
  } catch { return undefined; }
}

function truncateUtf8(value: string, maximum: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximum) return value;
  let result = "";
  let used = 0;
  const ellipsisBytes = encoder.encode("…").byteLength;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (used + bytes + ellipsisBytes > maximum) break;
    result += character;
    used += bytes;
  }
  return `${result}…`;
}
