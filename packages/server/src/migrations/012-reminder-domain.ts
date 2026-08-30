import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyReminderDomainMigration: StateMigration = (db) => {
  if (hasMigration(db, 12)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE reminder_items(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
        deadline_local_date TEXT NOT NULL CHECK(
          length(deadline_local_date)=10
          AND deadline_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        ),
        importance INTEGER NOT NULL CHECK(importance IN (1,3,5)),
        status TEXT NOT NULL CHECK(status IN ('active','completed','expired')),
        legacy_ref TEXT UNIQUE CHECK(legacy_ref IS NULL OR length(legacy_ref) BETWEEN 1 AND 240),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        expired_at TEXT,
        CHECK(
          (status='active' AND completed_at IS NULL AND expired_at IS NULL)
          OR (status='completed' AND completed_at IS NOT NULL AND expired_at IS NULL)
          OR (status='expired' AND expired_at IS NOT NULL AND completed_at IS NULL)
        )
      );
      CREATE INDEX reminder_items_status_deadline_idx
        ON reminder_items(status,deadline_local_date,importance,id);

      CREATE TABLE reminder_delivery_windows(
        delivery_key TEXT PRIMARY KEY CHECK(length(delivery_key) BETWEEN 1 AND 240),
        reminder_id TEXT REFERENCES reminder_items(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('daily_digest','escalation')),
        local_date TEXT NOT NULL CHECK(
          length(local_date)=10
          AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        ),
        slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 23),
        status TEXT NOT NULL CHECK(status IN ('completed','failed','uncertain','skipped_empty')),
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 500),
        legacy_ref TEXT UNIQUE CHECK(legacy_ref IS NULL OR length(legacy_ref) BETWEEN 1 AND 300),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (kind='daily_digest' AND reminder_id IS NULL)
          OR (kind='escalation' AND reminder_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX reminder_delivery_windows_schedule_idx
        ON reminder_delivery_windows(kind,local_date,slot,COALESCE(reminder_id,''));
      CREATE INDEX reminder_delivery_windows_status_idx
        ON reminder_delivery_windows(status,local_date,slot);
    `);
    recordMigration(db, 12, "durable reminder domain and delivery ledger");
  })();
};
