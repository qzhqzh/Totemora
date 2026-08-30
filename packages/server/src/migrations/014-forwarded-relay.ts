import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyForwardedRelayMigration: StateMigration = (db) => {
  if (hasMigration(db, 14)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE forwarded_events(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
        source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 64),
        source_message_id TEXT NOT NULL CHECK(length(source_message_id) BETWEEN 1 AND 128),
        content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
        occurred_at TEXT NOT NULL,
        title TEXT NOT NULL CHECK(length(title) <= 200),
        body TEXT NOT NULL CHECK(length(body) <= 12000),
        priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5),
        tags_json TEXT NOT NULL CHECK(json_valid(tags_json) AND json_type(tags_json)='array'),
        click_url TEXT CHECK(click_url IS NULL OR length(click_url) BETWEEN 1 AND 2048),
        image_url TEXT CHECK(image_url IS NULL OR length(image_url) BETWEEN 1 AND 2048),
        status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','uncertain','deduped')),
        attempts INTEGER NOT NULL CHECK(attempts >= 0),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 500),
        legacy_ref TEXT UNIQUE CHECK(legacy_ref IS NULL OR length(legacy_ref) BETWEEN 1 AND 240),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id,source_message_id),
        CHECK(length(title)>0 OR length(body)>0)
      );
      CREATE INDEX forwarded_events_status_occurred_idx
        ON forwarded_events(status,occurred_at,id);
      CREATE INDEX forwarded_events_legacy_hash_idx
        ON forwarded_events(content_hash,occurred_at) WHERE legacy_ref IS NOT NULL;

      CREATE TABLE forwarded_source_state(
        source_id TEXT PRIMARY KEY CHECK(length(source_id) BETWEEN 1 AND 64),
        cursor_time INTEGER NOT NULL CHECK(cursor_time >= 0),
        last_success_at TEXT,
        last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 500),
        last_added INTEGER NOT NULL CHECK(last_added >= 0),
        updated_at TEXT NOT NULL
      );
    `);
    recordMigration(db, 14, "governed forwarded ntfy relay");
  })();
};
