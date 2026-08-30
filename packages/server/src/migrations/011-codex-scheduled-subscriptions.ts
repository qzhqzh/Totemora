import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyCodexScheduledSubscriptionsMigration: StateMigration = (db) => {
  if (hasMigration(db, 11)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE codex_scheduled_subscriptions(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
        target_chat_id TEXT NOT NULL CHECK(length(target_chat_id) BETWEEN 1 AND 32),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
        last_run_key TEXT,
        last_delivery_status TEXT NOT NULL DEFAULT 'never'
          CHECK(last_delivery_status IN ('never','delivered','failed','uncertain')),
        last_delivered_at TEXT,
        last_error TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX codex_scheduled_subscriptions_status_idx
        ON codex_scheduled_subscriptions(status,created_at);

      CREATE TABLE codex_scheduled_delivery_windows(
        subscription_id TEXT NOT NULL
          REFERENCES codex_scheduled_subscriptions(id) ON DELETE CASCADE,
        delivery_date TEXT NOT NULL CHECK(length(delivery_date)=10),
        run_key TEXT NOT NULL CHECK(length(run_key) BETWEEN 1 AND 100),
        created_at TEXT NOT NULL,
        PRIMARY KEY(subscription_id,delivery_date)
      );

      CREATE TRIGGER codex_scheduled_subscriptions_limit_insert
      BEFORE INSERT ON codex_scheduled_subscriptions
      WHEN NEW.status='active' AND (
        SELECT COUNT(*) FROM codex_scheduled_subscriptions WHERE status='active'
      ) >= 3
      BEGIN
        SELECT RAISE(ABORT,'at most 3 active Codex scheduled subscriptions are allowed');
      END;

      CREATE TRIGGER codex_scheduled_subscriptions_limit_reactivate
      BEFORE UPDATE OF status ON codex_scheduled_subscriptions
      WHEN OLD.status!='active' AND NEW.status='active' AND (
        SELECT COUNT(*) FROM codex_scheduled_subscriptions WHERE status='active'
      ) >= 3
      BEGIN
        SELECT RAISE(ABORT,'at most 3 active Codex scheduled subscriptions are allowed');
      END;
    `);
    recordMigration(db, 11, "Codex scheduled Telegram subscriptions");
  })();
};
