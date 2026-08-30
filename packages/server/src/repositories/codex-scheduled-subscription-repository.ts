import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CODEX_SCHEDULED_SUBSCRIPTION_LIMIT,
  type CodexScheduledDeliveryStatus,
  type CodexScheduledSubscription,
} from "../domains/codex/codex-scheduled-subscription-types";
import { StateDatabase } from "../state-database";

interface SubscriptionRow extends Omit<CodexScheduledSubscription,
  "last_run_key" | "last_delivered_at" | "last_error" | "revoked_at"> {
  token_hash: string;
  last_run_key: string | null;
  last_delivered_at: string | null;
  last_error: string | null;
  revoked_at: string | null;
}

export class CodexScheduledSubscriptionLimitError extends Error {}
export class CodexScheduledDailyLimitError extends Error {}

export class CodexScheduledSubscriptionRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  create(input: { name: string; target_chat_id: string }): {
    subscription: CodexScheduledSubscription;
    token: string;
  } {
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    try {
      this.state.db.transaction(() => {
        const active = this.state.db.query(`
          SELECT COUNT(*) AS count FROM codex_scheduled_subscriptions WHERE status='active'
        `).get() as { count: number };
        if (active.count >= CODEX_SCHEDULED_SUBSCRIPTION_LIMIT) {
          throw new CodexScheduledSubscriptionLimitError(
            `最多只能启用 ${CODEX_SCHEDULED_SUBSCRIPTION_LIMIT} 个定时任务订阅`,
          );
        }
        this.state.db.query(`
          INSERT INTO codex_scheduled_subscriptions(
            id,name,token_hash,target_chat_id,status,last_delivery_status,revision,created_at,updated_at
          ) VALUES(?,?,?,?,'active','never',1,?,?)
        `).run(id, input.name, hashToken(token), input.target_chat_id, now, now);
      })();
    } catch (error) {
      if (error instanceof CodexScheduledSubscriptionLimitError
        || String(error).includes("at most 3 active Codex scheduled subscriptions")) {
        throw new CodexScheduledSubscriptionLimitError(
          `最多只能启用 ${CODEX_SCHEDULED_SUBSCRIPTION_LIMIT} 个定时任务订阅`,
        );
      }
      throw error;
    }
    return { subscription: this.getRequired(id), token };
  }

  listActive(): CodexScheduledSubscription[] {
    return (this.state.db.query(`
      SELECT * FROM codex_scheduled_subscriptions WHERE status='active' ORDER BY created_at,id
    `).all() as SubscriptionRow[]).map(fromRow);
  }

  get(id: string): CodexScheduledSubscription | undefined {
    const row = this.state.db.query("SELECT * FROM codex_scheduled_subscriptions WHERE id=?")
      .get(id) as SubscriptionRow | null;
    return row ? fromRow(row) : undefined;
  }

  verify(token: string): CodexScheduledSubscription | undefined {
    if (!token || token.length > 256) return undefined;
    const candidate = hashToken(token);
    const row = this.state.db.query(`
      SELECT * FROM codex_scheduled_subscriptions WHERE token_hash=? AND status='active'
    `).get(candidate) as SubscriptionRow | null;
    if (!row || !safeHashEqual(candidate, row.token_hash)) return undefined;
    return fromRow(row);
  }

  revoke(id: string, expectedRevision: number): CodexScheduledSubscription {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_scheduled_subscriptions
      SET status='revoked',revoked_at=?,revision=revision+1,updated_at=?
      WHERE id=? AND status='active' AND revision=?
    `).run(now, now, id, expectedRevision);
    if (result.changes !== 1) {
      const existing = this.get(id);
      if (!existing) throw new Error(`Codex scheduled subscription not found: ${id}`);
      throw new Error(`Codex scheduled subscription revision conflict: ${id}`);
    }
    return this.getRequired(id);
  }

  reserveDeliveryWindow(id: string, deliveryDate: string, runKey: string): void {
    this.state.db.transaction(() => {
      if (this.deliveryWindowRunKey(id, deliveryDate) === runKey) return;
      this.assertDeliveryWindowAvailable(id, deliveryDate, runKey);
      this.state.db.query(`
        INSERT INTO codex_scheduled_delivery_windows(subscription_id,delivery_date,run_key,created_at)
        VALUES(?,?,?,?)
      `).run(id, deliveryDate, runKey, new Date().toISOString());
    })();
  }

  assertDeliveryWindowAvailable(id: string, deliveryDate: string, runKey: string): void {
    const existingRunKey = this.deliveryWindowRunKey(id, deliveryDate);
    if (existingRunKey && existingRunKey !== runKey) {
      throw new CodexScheduledDailyLimitError(
        "该订阅今天已经投递过一份摘要，请等待下一个 Asia/Shanghai 自然日",
      );
    }
  }

  recordDelivery(
    id: string,
    runKey: string,
    status: Exclude<CodexScheduledDeliveryStatus, "never">,
    error?: string,
    sourceAt = new Date().toISOString(),
  ): void {
    this.state.db.transaction(() => {
      const current = this.getRequired(id);
      if (Date.parse(sourceAt) < Date.parse(current.updated_at)) return;
      if (current.last_run_key === runKey
        && current.last_delivery_status === status
        && current.updated_at === sourceAt) return;
      if (status !== "delivered"
        && current.last_delivery_status === "delivered"
        && current.last_run_key === runKey) return;
      this.state.db.query(`
        UPDATE codex_scheduled_subscriptions SET
          last_run_key=?,last_delivery_status=?,
          last_delivered_at=CASE WHEN ?='delivered' THEN ? ELSE last_delivered_at END,
          last_error=?,updated_at=?
        WHERE id=?
      `).run(
        runKey,
        status,
        status,
        sourceAt,
        error?.slice(0, 500) ?? null,
        sourceAt,
        id,
      );
    })();
  }

  private getRequired(id: string): CodexScheduledSubscription {
    const subscription = this.get(id);
    if (!subscription) throw new Error(`Codex scheduled subscription not found: ${id}`);
    return subscription;
  }

  private deliveryWindowRunKey(id: string, deliveryDate: string): string | undefined {
    const row = this.state.db.query(`
      SELECT run_key FROM codex_scheduled_delivery_windows
      WHERE subscription_id=? AND delivery_date=?
    `).get(id, deliveryDate) as { run_key: string } | null;
    return row?.run_key;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function fromRow(row: SubscriptionRow): CodexScheduledSubscription {
  return {
    id: row.id,
    name: row.name,
    target_chat_id: row.target_chat_id,
    status: row.status,
    last_run_key: row.last_run_key ?? undefined,
    last_delivery_status: row.last_delivery_status,
    last_delivered_at: row.last_delivered_at ?? undefined,
    last_error: row.last_error ?? undefined,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at ?? undefined,
  };
}
