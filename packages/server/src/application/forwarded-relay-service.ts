import type { NotificationDispatchResult } from "./notification-dispatcher";
import { forwardedDeliveryKey, type ForwardedEvent, type ForwardedEventInput, type ForwardedStatus } from "../domains/forwarded/forwarded-event";
import { ForwardedRepository, type ForwardedSummary } from "../repositories/forwarded-repository";

export interface ForwardedRelaySource {
  readonly source_id: string;
  configured(): Promise<boolean>;
  collect(sinceEpoch: number): Promise<ForwardedEventInput[]>;
}
export interface ForwardedRelayDispatcher {
  dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult>;
}
export interface ForwardedRelayRunReport {
  state: "disabled" | "completed";
  fetched: number;
  inserted: number;
  deduped: number;
  delivered: number;
  failed: number;
  uncertain: number;
  pending_after_run: number;
}

export class ForwardedRelayService {
  private readonly repository: ForwardedRepository;

  constructor(private readonly input: {
    dataDir: string;
    source: ForwardedRelaySource;
    dispatcher: ForwardedRelayDispatcher;
  }) {
    this.repository = new ForwardedRepository(input.dataDir);
  }

  list(status: ForwardedStatus | "all" = "all", limit = 50): ForwardedEvent[] {
    return this.repository.list(status, limit);
  }

  async status(): Promise<ForwardedSummary & { configured: boolean }> {
    return { ...this.repository.summary(this.input.source.source_id), configured: await this.input.source.configured() };
  }

  async runDue(now = new Date()): Promise<ForwardedRelayRunReport> {
    if (!(await this.input.source.configured())) return emptyReport("disabled");
    const current = this.repository.sourceState(this.input.source.source_id);
    const nowEpoch = Math.floor(now.getTime() / 1_000);
    const since = current?.cursor_time ? Math.max(0, current.cursor_time - 1) : Math.max(0, nowEpoch - 600);
    let events: ForwardedEventInput[];
    let ingested: ReturnType<ForwardedRepository["ingestPoll"]>;
    try {
      events = await this.input.source.collect(since);
      ingested = this.repository.ingestPoll({
        source_id: this.input.source.source_id,
        events,
        cursor_time: current?.cursor_time ?? 0,
      });
    } catch (error) {
      this.repository.recordPollFailure(this.input.source.source_id, safeError(error));
      throw error;
    }

    const report: ForwardedRelayRunReport = {
      state: "completed", fetched: events.length, inserted: ingested.inserted,
      deduped: ingested.deduped, delivered: 0, failed: 0, uncertain: 0, pending_after_run: 0,
    };
    for (const event of this.repository.pending(20)) {
      await this.dispatch(event, report);
    }
    report.pending_after_run = this.repository.pending(100).length;
    return report;
  }

  private async dispatch(event: ForwardedEvent, report: ForwardedRelayRunReport): Promise<void> {
    try {
      const result = await this.input.dispatcher.dispatch({
        member_id: "forwarded.relay",
        envelope: envelope(event),
      });
      const status = result.status === "completed" ? "completed"
        : result.status === "uncertain" ? "uncertain" : "failed";
      this.repository.recordDelivery({
        id: event.id, status, result,
        ...(status === "failed" ? { error: dispatchFailure(result) } : {}),
      });
      if (status === "completed") report.delivered += 1;
      else report[status] += 1;
    } catch (error) {
      this.repository.recordDelivery({ id: event.id, status: "failed", error: safeError(error) });
      report.failed += 1;
    }
  }
}

function envelope(event: ForwardedEvent): unknown {
  const key = forwardedDeliveryKey(event);
  const title = event.title ? `↗️ 转发｜${event.title}`.slice(0, 200) : "↗️ 转发";
  const tags = [...new Set(event.tags.filter((tag) => tag !== "outbox_tray"))].slice(0, 19);
  tags.push("outbox_tray");
  return {
    schema_version: 1,
    id: key,
    idempotency_key: key,
    domain: "forwarded",
    kind: "relay",
    title,
    body: event.body || "（上游通知无正文）",
    priority: event.priority,
    tags,
    source: { source_id: event.source_message_id, occurred_at: event.occurred_at },
    ...(event.click_url ? { click_url: event.click_url } : {}),
    ...(event.image_url ? { image_url: event.image_url } : {}),
  };
}

function dispatchFailure(result: NotificationDispatchResult): string {
  if (result.status === "unconfigured") return "No notification target is configured for forwarded relay";
  return result.deliveries.filter((item) => item.status !== "completed")
    .map((item) => `${item.channel}:${item.target_id}:${item.status}`).join(", ")
    || `Forwarded notification dispatch ${result.status}`;
}
function emptyReport(state: "disabled"): ForwardedRelayRunReport {
  return { state, fetched: 0, inserted: 0, deduped: 0, delivered: 0, failed: 0, uncertain: 0, pending_after_run: 0 };
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500)
    || "Unknown forwarded relay error";
}
