import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyProjectRadarDigestsMigration: StateMigration = (db) => {
  if (hasMigration(db, 18)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE project_radar_digests(
        day TEXT PRIMARY KEY CHECK(length(day)=10),
        status TEXT NOT NULL CHECK(status IN ('sending','completed','failed','uncertain','empty')),
        attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
        lease_token TEXT,
        lease_expires_at TEXT,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'
          AND json_extract(payload_json,'$.date') IS day AND length(CAST(payload_json AS BLOB))<=65536),
        last_error TEXT CHECK(last_error IS NULL OR length(last_error)<=500),
        retry_after TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((status='sending' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND attempts>=1)
          OR (status!='sending' AND lease_token IS NULL AND lease_expires_at IS NULL)),
        CHECK(retry_after IS NULL OR status='failed')
      );
      CREATE TABLE project_radar_digest_items(
        candidate_id TEXT PRIMARY KEY REFERENCES intelligence_candidates(id),
        digest_day TEXT NOT NULL REFERENCES project_radar_digests(day),
        previous_status TEXT NOT NULL CHECK(previous_status IN ('queued','retry_wait','channel_blocked'))
      );
      CREATE INDEX project_radar_digest_items_day ON project_radar_digest_items(digest_day);
      CREATE TABLE project_radar_runtime(
        id INTEGER PRIMARY KEY CHECK(id=1),
        last_evaluation_window TEXT,
        fallback_until TEXT
      );
      INSERT INTO project_radar_runtime(id) VALUES(1);
    `);
    recordMigration(db, 18, "project radar digest snapshots and delivery leases");
  })();
};
