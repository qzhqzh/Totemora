import type { NotificationDispatchResult } from "./notification-dispatcher";
import { dealWindowKey, formatDealDigest, shanghaiHour, type CollectedDeal, type DealItem, type DealStatus } from "../domains/deals/deal";
import { DealRepository, type DealSummary } from "../repositories/deal-repository";

export interface DealsSource {
  collect(): Promise<CollectedDeal[]>;
}
export interface DealsNotificationDispatcher {
  dispatch(input: { envelope: unknown; member_id: string }): Promise<NotificationDispatchResult>;
}
export interface DealsRunReport {
  local_hour: string;
  source_fetched: number;
  inserted_items: number;
  selected_items: number;
  delivery_status: "completed" | "failed" | "uncertain" | "skipped_empty" | "skipped_existing";
  retried_window: boolean;
}

export class DealsService {
  private readonly repository: DealRepository;

  constructor(private readonly input: {
    dataDir: string;
    source: DealsSource;
    dispatcher: DealsNotificationDispatcher;
  }) {
    this.repository = new DealRepository(input.dataDir);
  }

  list(status: DealStatus | "all" = "all", limit = 50): DealItem[] {
    return this.repository.list(status, limit);
  }

  status(): DealSummary { return this.repository.summary(); }

  async runDue(now = new Date()): Promise<DealsRunReport> {
    const clock = shanghaiHour(now);
    const currentKey = dealWindowKey(clock.local_hour);
    const existingCurrent = this.repository.getWindow(currentKey);
    if (existingCurrent && ["completed", "uncertain", "skipped_empty"].includes(existingCurrent.status)) {
      return {
        local_hour: clock.local_hour, source_fetched: 0, inserted_items: 0,
        selected_items: existingCurrent.item_count, delivery_status: "skipped_existing", retried_window: false,
      };
    }

    let window = this.repository.oldestRetryableWindow();
    let fetched = 0;
    let inserted = 0;
    const retried = Boolean(window);
    if (!window) {
      const startedAt = clock.now_iso;
      try {
        const collected = await this.input.source.collect();
        fetched = collected.length;
        inserted = this.repository.storeCollected(collected, clock.now_iso);
        window = this.repository.createWindow(clock.local_hour, 5, clock.now_iso);
        this.repository.recordSourceRun({
          status: "success", started_at: startedAt, finished_at: new Date().toISOString(),
          fetched_count: fetched, inserted_count: inserted, selected_count: window.item_count,
        });
      } catch (error) {
        const message = safeError(error);
        this.repository.recordSourceRun({
          status: "error", started_at: startedAt, finished_at: new Date().toISOString(),
          fetched_count: 0, inserted_count: 0, selected_count: 0, error: message,
        });
        throw error;
      }
    }
    if (window.status === "skipped_empty") {
      return {
        local_hour: clock.local_hour, source_fetched: fetched, inserted_items: inserted,
        selected_items: 0, delivery_status: "skipped_empty", retried_window: retried,
      };
    }

    const selected = this.repository.windowItems(window.window_key);
    if (!selected.length) throw new Error(`Deal delivery window has no items: ${window.window_key}`);
    try {
      const result = await this.input.dispatcher.dispatch({
        member_id: "deals.service",
        envelope: dealEnvelope(window.window_key, window.local_hour, selected),
      });
      const deliveryStatus = result.status === "completed" ? "completed"
        : result.status === "uncertain" ? "uncertain" : "failed";
      this.repository.recordDelivery({
        window_key: window.window_key,
        status: deliveryStatus,
        result,
        ...(deliveryStatus === "failed" ? { error: dispatchFailure(result) } : {}),
      });
      return {
        local_hour: clock.local_hour, source_fetched: fetched, inserted_items: inserted,
        selected_items: selected.length, delivery_status: deliveryStatus, retried_window: retried,
      };
    } catch (error) {
      this.repository.recordDelivery({
        window_key: window.window_key, status: "failed", error: safeError(error),
      });
      return {
        local_hour: clock.local_hour, source_fetched: fetched, inserted_items: inserted,
        selected_items: selected.length, delivery_status: "failed", retried_window: retried,
      };
    }
  }
}

function dealEnvelope(windowKey: string, localHour: string, items: DealItem[]): unknown {
  const first = items[0]!;
  return {
    schema_version: 1,
    id: windowKey,
    idempotency_key: windowKey,
    domain: "deals",
    kind: "digest",
    title: `羊毛简报｜${localHour.slice(11)}:00`,
    body: formatDealDigest(items),
    priority: 3,
    tags: ["moneybag", "deals"],
    source: { source_id: first.source_id, url: first.source_url, occurred_at: first.discovered_at },
    click_url: first.source_url,
    ...(first.image_url ? { image_url: first.image_url } : {}),
  };
}

function dispatchFailure(result: NotificationDispatchResult): string {
  if (result.status === "unconfigured") return "No notification target is configured for deals";
  const failed = result.deliveries.filter((item) => item.status !== "completed")
    .map((item) => `${item.channel}:${item.target_id}:${item.status}`);
  return failed.join(", ") || `Deals notification dispatch ${result.status}`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500)
    || "Unknown deals service error";
}
