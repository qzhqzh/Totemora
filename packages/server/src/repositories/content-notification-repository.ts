import { StateDatabase } from "../state-database";

export type ContentNotificationStatus = "pending" | "completed" | "failed" | "uncertain" | "suppressed";

export interface ContentNotificationRecord {
  schema_version: 1;
  work_id: string;
  status: ContentNotificationStatus;
  attempts: number;
  dispatch_result?: unknown;
  last_error?: string;
  retry_after?: string;
  suppression_reason?: string;
  created_at: string;
  updated_at: string;
}

const NAMESPACE = "content:notifications";
const SETTINGS_NAMESPACE = "content:notification-settings";
const CUTOVER_ID = "scheduled-draft-v1";

export class ContentNotificationRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  get(workId: string): ContentNotificationRecord | undefined {
    const row = this.state.db.query(
      "SELECT payload_json FROM records WHERE namespace=? AND id=?",
    ).get(NAMESPACE, workId) as { payload_json: string } | null;
    return row ? JSON.parse(row.payload_json) as ContentNotificationRecord : undefined;
  }

  dueScheduledWorkIds(now: string, limit = 200): string[] {
    const rows = this.state.db.query(`
      SELECT task.result_ref AS work_id
      FROM specialist_tasks task
      LEFT JOIN records notification
        ON notification.namespace=? AND notification.id=task.result_ref
      WHERE task.service_id='content.studio'
        AND task.trigger='scheduled'
        AND task.status='completed'
        AND task.result_ref IS NOT NULL
        AND (
          notification.id IS NULL
          OR (
            json_extract(notification.payload_json,'$.status')='failed'
            AND (
              json_extract(notification.payload_json,'$.retry_after') IS NULL
              OR json_extract(notification.payload_json,'$.retry_after')<=?
            )
          )
        )
      ORDER BY task.updated_at,task.id LIMIT ?
    `).all(NAMESPACE, now, Math.max(1, Math.min(200, limit))) as Array<{ work_id: string }>;
    return rows.map((row) => row.work_id);
  }

  ensureCutover(now: string): string {
    const row = this.state.db.query(
      "SELECT payload_json FROM records WHERE namespace=? AND id=?",
    ).get(SETTINGS_NAMESPACE, CUTOVER_ID) as { payload_json: string } | null;
    if (row) return (JSON.parse(row.payload_json) as { cutover_at: string }).cutover_at;
    this.state.putRecord(SETTINGS_NAMESPACE, CUTOVER_ID, {
      schema_version: 1, cutover_at: now,
    }, now, now);
    return now;
  }

  suppress(workId: string, reason: string, now: string): ContentNotificationRecord {
    const record: ContentNotificationRecord = {
      schema_version: 1,
      work_id: workId,
      status: "suppressed",
      attempts: 0,
      suppression_reason: reason,
      created_at: now,
      updated_at: now,
    };
    this.state.putRecord(NAMESPACE, workId, record, now, now);
    return record;
  }

  begin(workId: string, now: string): ContentNotificationRecord {
    const existing = this.get(workId);
    const record: ContentNotificationRecord = {
      schema_version: 1,
      work_id: workId,
      status: "pending",
      attempts: (existing?.attempts ?? 0) + 1,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.state.putRecord(NAMESPACE, workId, record, record.created_at, now);
    return record;
  }

  finish(input: {
    record: ContentNotificationRecord;
    status: "completed" | "failed" | "uncertain";
    now: string;
    dispatch_result?: unknown;
    last_error?: string;
    retry_after?: string;
  }): ContentNotificationRecord {
    const record: ContentNotificationRecord = {
      ...input.record,
      status: input.status,
      updated_at: input.now,
      ...(input.dispatch_result === undefined ? {} : { dispatch_result: input.dispatch_result }),
      ...(input.last_error ? { last_error: safeError(input.last_error) } : {}),
      ...(input.retry_after ? { retry_after: input.retry_after } : {}),
    };
    this.state.putRecord(NAMESPACE, record.work_id, record, record.created_at, input.now);
    return record;
  }
}

function safeError(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500)
    || "Unknown content notification error";
}
