import {
  DEAL_STATUS_VALUES,
  DEAL_WINDOW_STATUS_VALUES,
  assertLocalHour,
  dealId,
  dealWindowKey,
  normalizeCollectedDeal,
  type CollectedDeal,
  type DealDeliveryWindow,
  type DealItem,
  type DealSourceRun,
  type DealStatus,
  type DealWindowStatus,
} from "../domains/deals/deal";
import { StateDatabase } from "../state-database";

interface ItemRow {
  id: string; source_id: string; title: string; deal_text: string; merchant: string;
  source_url: string; image_url: string | null; source_rank: number; status: DealStatus;
  discovered_at: string; updated_at: string; terminal_at: string | null; legacy_ref: string | null;
}
interface WindowRow {
  window_key: string; local_hour: string; status: DealWindowStatus; item_count: number;
  attempts: number; result_json: string | null; last_error: string | null;
  created_at: string; updated_at: string;
}
interface SourceRunRow {
  id: string; status: "success" | "error"; started_at: string; finished_at: string;
  fetched_count: number; inserted_count: number; selected_count: number; last_error: string | null;
}
export interface LegacyDealImportBundle {
  source_ref: string;
  source_sha256: string;
  source_row_count: number;
  items: Array<DealItem & { legacy_ref: string }>;
}
export interface LegacyDealImportResult { applied: boolean; items: number; inserted_items: number }
export interface DealSummary {
  counts: Record<DealStatus, number>;
  latest_source_run?: DealSourceRun;
  latest_delivery_window?: DealDeliveryWindow;
}

const IMPORT_NAMESPACE = "legacy:notice-ntfy:deals";
const TERMINAL_WINDOWS = new Set<DealWindowStatus>(["completed", "uncertain", "skipped_empty"]);

export class DealRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) { this.state = StateDatabase.open(dataDir); }

  list(status: DealStatus | "all" = "all", limit = 50): DealItem[] {
    boundedInteger(limit, "Deal list limit", 1, 100);
    const rows = status === "all"
      ? this.state.db.query("SELECT * FROM deal_items ORDER BY discovered_at DESC,source_rank,id LIMIT ?").all(limit)
      : this.state.db.query("SELECT * FROM deal_items WHERE status=? ORDER BY discovered_at DESC,source_rank,id LIMIT ?")
        .all(status, limit);
    return (rows as ItemRow[]).map(itemFromRow);
  }

  storeCollected(items: CollectedDeal[], now = new Date().toISOString()): number {
    const timestamp = validIso(now, "Deal discovered_at");
    let inserted = 0;
    this.state.db.transaction(() => {
      for (const raw of items) {
        const item = normalizeCollectedDeal(raw);
        inserted += this.state.db.query(`
          INSERT OR IGNORE INTO deal_items(
            id,source_id,title,deal_text,merchant,source_url,image_url,source_rank,status,
            discovered_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)
        `).run(
          dealId(item.source_id), item.source_id, item.title, item.deal_text, item.merchant,
          item.source_url, item.image_url ?? null, item.source_rank, timestamp, timestamp,
        ).changes;
      }
    })();
    return inserted;
  }

  createWindow(localHour: string, limit = 5, now = new Date().toISOString()): DealDeliveryWindow {
    const hour = assertLocalHour(localHour);
    boundedInteger(limit, "Deal delivery limit", 1, 5);
    const key = dealWindowKey(hour);
    const timestamp = validIso(now, "Deal window timestamp");
    this.state.db.transaction(() => {
      if (this.getWindow(key)) return;
      const items = this.state.db.query(`
        SELECT id FROM deal_items WHERE status='pending'
        ORDER BY discovered_at DESC,source_rank,id LIMIT ?
      `).all(limit) as Array<{ id: string }>;
      this.state.db.query(`
        INSERT INTO deal_delivery_windows(window_key,local_hour,status,attempts,created_at,updated_at)
        VALUES(?,?,?,0,?,?)
      `).run(key, hour, items.length ? "pending" : "skipped_empty", timestamp, timestamp);
      for (const [position, item] of items.entries()) {
        this.state.db.query("INSERT INTO deal_delivery_items(window_key,item_id,position) VALUES(?,?,?)")
          .run(key, item.id, position + 1);
      }
    })();
    return this.getWindowRequired(key);
  }

  getWindow(windowKey: string): DealDeliveryWindow | undefined {
    const row = this.state.db.query(`
      SELECT w.*,COUNT(i.item_id) AS item_count FROM deal_delivery_windows w
      LEFT JOIN deal_delivery_items i ON i.window_key=w.window_key
      WHERE w.window_key=? GROUP BY w.window_key
    `).get(windowKey) as WindowRow | null;
    return row ? windowFromRow(row) : undefined;
  }

  oldestRetryableWindow(): DealDeliveryWindow | undefined {
    const row = this.state.db.query(`
      SELECT w.*,COUNT(i.item_id) AS item_count FROM deal_delivery_windows w
      LEFT JOIN deal_delivery_items i ON i.window_key=w.window_key
      WHERE w.status IN ('pending','failed') GROUP BY w.window_key ORDER BY w.local_hour LIMIT 1
    `).get() as WindowRow | null;
    return row ? windowFromRow(row) : undefined;
  }

  windowItems(windowKey: string): DealItem[] {
    return (this.state.db.query(`
      SELECT d.* FROM deal_delivery_items i JOIN deal_items d ON d.id=i.item_id
      WHERE i.window_key=? ORDER BY i.position
    `).all(windowKey) as ItemRow[]).map(itemFromRow);
  }

  recordDelivery(input: {
    window_key: string;
    status: "completed" | "failed" | "uncertain";
    result?: unknown;
    error?: string;
    now?: string;
  }): DealDeliveryWindow {
    const existing = this.getWindowRequired(input.window_key);
    if (TERMINAL_WINDOWS.has(existing.status)) return existing;
    const now = validIso(input.now ?? new Date().toISOString(), "Deal delivery timestamp");
    const result = input.result === undefined ? null : boundedJson(input.result);
    const error = input.error ? safeError(input.error) : null;
    this.state.db.transaction(() => {
      this.state.db.query(`
        UPDATE deal_delivery_windows SET status=?,attempts=attempts+1,result_json=?,last_error=?,updated_at=?
        WHERE window_key=?
      `).run(input.status, result, error, now, input.window_key);
      if (input.status === "failed") return;
      const itemStatus = input.status === "completed" ? "delivered" : "uncertain";
      this.state.db.query(`
        UPDATE deal_items SET status=?,terminal_at=?,updated_at=?
        WHERE id IN (SELECT item_id FROM deal_delivery_items WHERE window_key=?) AND status='pending'
      `).run(itemStatus, now, now, input.window_key);
      this.state.db.query(`
        UPDATE deal_items SET status='skipped',terminal_at=?,updated_at=? WHERE status='pending'
      `).run(now, now);
    })();
    return this.getWindowRequired(input.window_key);
  }

  recordSourceRun(input: Omit<DealSourceRun, "id">): DealSourceRun {
    const id = crypto.randomUUID();
    const error = input.error ? safeError(input.error) : null;
    this.state.db.query(`
      INSERT INTO deal_source_runs(
        id,status,started_at,finished_at,fetched_count,inserted_count,selected_count,last_error
      ) VALUES(?,?,?,?,?,?,?,?)
    `).run(
      id, input.status, validIso(input.started_at, "Deal run started_at"),
      validIso(input.finished_at, "Deal run finished_at"), nonNegative(input.fetched_count),
      nonNegative(input.inserted_count), nonNegative(input.selected_count), error,
    );
    return { id, ...input, ...(error ? { error } : {}) };
  }

  summary(): DealSummary {
    const counts = Object.fromEntries(DEAL_STATUS_VALUES.map((status) => [status, 0])) as Record<DealStatus, number>;
    const countRows = this.state.db.query("SELECT status,COUNT(*) AS count FROM deal_items GROUP BY status").all() as Array<{
      status: DealStatus; count: number;
    }>;
    for (const row of countRows) counts[row.status] = row.count;
    const source = this.state.db.query("SELECT * FROM deal_source_runs ORDER BY finished_at DESC,id DESC LIMIT 1")
      .get() as SourceRunRow | null;
    const window = this.state.db.query(`
      SELECT w.*,COUNT(i.item_id) AS item_count FROM deal_delivery_windows w
      LEFT JOIN deal_delivery_items i ON i.window_key=w.window_key
      GROUP BY w.window_key ORDER BY w.local_hour DESC LIMIT 1
    `).get() as WindowRow | null;
    return {
      counts,
      ...(source ? { latest_source_run: sourceRunFromRow(source) } : {}),
      ...(window ? { latest_delivery_window: windowFromRow(window) } : {}),
    };
  }

  importLegacy(bundle: LegacyDealImportBundle): LegacyDealImportResult {
    validateImport(bundle);
    let result = { applied: false, items: bundle.items.length, inserted_items: 0 };
    this.state.db.transaction(() => {
      const prior = this.state.db.query("SELECT payload_json FROM records WHERE namespace=? AND id=?")
        .get(IMPORT_NAMESPACE, bundle.source_ref) as { payload_json: string } | null;
      if (prior) {
        if ((JSON.parse(prior.payload_json) as { source_sha256?: string }).source_sha256 !== bundle.source_sha256) {
          throw new Error(`Legacy deals source changed after import: ${bundle.source_ref}`);
        }
        return;
      }
      let inserted = 0;
      for (const legacy of bundle.items) {
        const item = normalizeCollectedDeal(legacy);
        if (legacy.status === "pending" || !DEAL_STATUS_VALUES.includes(legacy.status)) {
          throw new Error("Legacy deal status must be terminal");
        }
        inserted += this.state.db.query(`
          INSERT OR IGNORE INTO deal_items(
            id,source_id,title,deal_text,merchant,source_url,image_url,source_rank,status,
            discovered_at,updated_at,terminal_at,legacy_ref
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          dealId(item.source_id), item.source_id, item.title, item.deal_text, item.merchant,
          item.source_url, item.image_url ?? null, item.source_rank, legacy.status,
          validIso(legacy.discovered_at, "Legacy deal discovered_at"),
          validIso(legacy.updated_at, "Legacy deal updated_at"),
          validIso(legacy.terminal_at, "Legacy deal terminal_at"),
          stableKey(legacy.legacy_ref, "Legacy deal ref", 240),
        ).changes;
      }
      const now = new Date().toISOString();
      this.state.db.query("INSERT INTO records(namespace,id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(IMPORT_NAMESPACE, bundle.source_ref, JSON.stringify({
          schema_version: 1, source_sha256: bundle.source_sha256,
          source_row_count: bundle.source_row_count, items: bundle.items.length,
          inserted_items: inserted, imported_at: now,
        }), now, now);
      result = { applied: true, items: bundle.items.length, inserted_items: inserted };
    })();
    return result;
  }

  private getWindowRequired(key: string): DealDeliveryWindow {
    const window = this.getWindow(key);
    if (!window) throw new Error(`Deal delivery window not found: ${key}`);
    return window;
  }
}

function itemFromRow(row: ItemRow): DealItem {
  return {
    id: row.id, source_id: row.source_id, title: row.title, deal_text: row.deal_text,
    merchant: row.merchant, source_url: row.source_url, source_rank: row.source_rank,
    status: row.status, discovered_at: row.discovered_at, updated_at: row.updated_at,
    ...(row.image_url ? { image_url: row.image_url } : {}),
    ...(row.terminal_at ? { terminal_at: row.terminal_at } : {}),
    ...(row.legacy_ref ? { legacy_ref: row.legacy_ref } : {}),
  };
}
function windowFromRow(row: WindowRow): DealDeliveryWindow {
  return {
    window_key: row.window_key, local_hour: row.local_hour, status: row.status,
    item_count: row.item_count, attempts: row.attempts, created_at: row.created_at, updated_at: row.updated_at,
    ...(row.result_json ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
  };
}
function sourceRunFromRow(row: SourceRunRow): DealSourceRun {
  return {
    id: row.id, status: row.status, started_at: row.started_at, finished_at: row.finished_at,
    fetched_count: row.fetched_count, inserted_count: row.inserted_count, selected_count: row.selected_count,
    ...(row.last_error ? { error: row.last_error } : {}),
  };
}
function validateImport(bundle: LegacyDealImportBundle): void {
  stableKey(bundle.source_ref, "Legacy deals source_ref", 200);
  if (!/^[a-f0-9]{64}$/.test(bundle.source_sha256)) throw new Error("Legacy deals SHA-256 is invalid");
  nonNegative(bundle.source_row_count);
}
function validIso(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be ISO-8601`);
  return new Date(value).toISOString();
}
function stableKey(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function boundedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 64 * 1_024) {
    throw new Error("Deal delivery result exceeds 65536 bytes");
  }
  return encoded;
}
function safeError(value: string): string { return value.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 500); }
function nonNegative(value: number): number { return boundedInteger(value, "Deal count", 0, Number.MAX_SAFE_INTEGER); }
function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}
