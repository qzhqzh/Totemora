import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyDealsDomainMigration: StateMigration = (db) => {
  if (hasMigration(db, 13)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE deal_items(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
        source_id TEXT NOT NULL UNIQUE CHECK(length(source_id) BETWEEN 1 AND 256),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
        deal_text TEXT NOT NULL CHECK(length(deal_text) <= 200),
        merchant TEXT NOT NULL CHECK(length(merchant) <= 120),
        source_url TEXT NOT NULL CHECK(length(source_url) BETWEEN 1 AND 2048),
        image_url TEXT CHECK(image_url IS NULL OR length(image_url) BETWEEN 1 AND 2048),
        source_rank INTEGER NOT NULL CHECK(source_rank BETWEEN 1 AND 1000),
        status TEXT NOT NULL CHECK(status IN ('pending','delivered','uncertain','skipped')),
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        legacy_ref TEXT UNIQUE CHECK(legacy_ref IS NULL OR length(legacy_ref) BETWEEN 1 AND 240),
        CHECK(
          (status='pending' AND terminal_at IS NULL)
          OR (status!='pending' AND terminal_at IS NOT NULL)
        )
      );
      CREATE INDEX deal_items_status_discovered_idx
        ON deal_items(status,discovered_at DESC,source_rank,id);

      CREATE TABLE deal_delivery_windows(
        window_key TEXT PRIMARY KEY CHECK(length(window_key) BETWEEN 1 AND 200),
        local_hour TEXT NOT NULL UNIQUE CHECK(
          length(local_hour)=13
          AND local_hour GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]'
          AND CAST(substr(local_hour,12,2) AS INTEGER) BETWEEN 0 AND 23
        ),
        status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','uncertain','skipped_empty')),
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 500),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX deal_delivery_windows_status_hour_idx
        ON deal_delivery_windows(status,local_hour);

      CREATE TABLE deal_delivery_items(
        window_key TEXT NOT NULL REFERENCES deal_delivery_windows(window_key) ON DELETE RESTRICT,
        item_id TEXT NOT NULL UNIQUE REFERENCES deal_items(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
        PRIMARY KEY(window_key,item_id),
        UNIQUE(window_key,position)
      );

      CREATE TABLE deal_source_runs(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
        status TEXT NOT NULL CHECK(status IN ('success','error')),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        fetched_count INTEGER NOT NULL CHECK(fetched_count >= 0),
        inserted_count INTEGER NOT NULL CHECK(inserted_count >= 0),
        selected_count INTEGER NOT NULL CHECK(selected_count >= 0),
        last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 500),
        CHECK(
          (status='success' AND last_error IS NULL)
          OR (status='error' AND last_error IS NOT NULL)
        )
      );
      CREATE INDEX deal_source_runs_finished_idx ON deal_source_runs(finished_at DESC,id);
    `);
    recordMigration(db, 13, "durable deals collection and delivery ledger");
  })();
};
