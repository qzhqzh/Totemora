import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyNotificationIngressMigration: StateMigration = (db) => {
  if (hasMigration(db, 16)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE external_notification_events(
        event_uuid TEXT PRIMARY KEY,
        source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 64),
        external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 128),
        type TEXT NOT NULL CHECK(length(type) BETWEEN 1 AND 100),
        payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 12000),
        priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5),
        occurred_at TEXT NOT NULL,
        dedupe_key TEXT CHECK(dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 128),
        coalesced_by TEXT REFERENCES external_notification_events(event_uuid),
        route_targets_json TEXT NOT NULL CHECK(json_valid(route_targets_json) AND json_type(route_targets_json)='array'),
        status TEXT NOT NULL CHECK(status IN ('pending','unrouted','coalesced','sending','completed','failed','uncertain')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 500),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id,external_id)
      );
      CREATE INDEX external_notification_events_queue_idx
        ON external_notification_events(status,created_at,event_uuid);
      CREATE INDEX external_notification_events_coalesce_idx
        ON external_notification_events(source_id,type,dedupe_key,created_at)
        WHERE dedupe_key IS NOT NULL;
    `);
    recordMigration(db, 16, "authenticated external notification inbox");
  })();
};
