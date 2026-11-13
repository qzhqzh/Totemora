import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyProjectRadarMigration: StateMigration = (db) => {
  if (hasMigration(db, 17)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE project_radar_settings(
        id INTEGER PRIMARY KEY CHECK(id=1),
        mode TEXT NOT NULL CHECK(mode IN ('off','shadow','active')),
        settings_json TEXT NOT NULL CHECK(json_valid(settings_json) AND json_type(settings_json)='object'
          AND json_extract(settings_json,'$.mode')=mode AND json_extract(settings_json,'$.version')=1),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_radar_evaluations(
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES intelligence_candidates(id),
        route TEXT NOT NULL CHECK(route IN ('immediate','digest','hold','review')),
        settings_fingerprint TEXT NOT NULL CHECK(length(settings_fingerprint)=64),
        input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint)=64),
        evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json) AND json_type(evaluation_json)='object'
          AND json_extract(evaluation_json,'$.route')=route),
        created_at TEXT NOT NULL,
        UNIQUE(candidate_id,settings_fingerprint,input_fingerprint)
      );
      CREATE INDEX project_radar_evaluations_latest ON project_radar_evaluations(created_at DESC);
      CREATE TABLE project_radar_usage(
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL CHECK(length(day)=10),
        cache_key TEXT NOT NULL CHECK(length(cache_key)=64),
        candidate_id TEXT NOT NULL REFERENCES intelligence_candidates(id),
        status TEXT NOT NULL CHECK(status IN ('reserved','completed','failed')),
        input_tokens INTEGER NOT NULL CHECK(input_tokens>=0),
        reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>=1),
        error TEXT CHECK(error IS NULL OR length(error)<=500),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(day,cache_key)
      );
      CREATE INDEX project_radar_usage_day ON project_radar_usage(day,status);
    `);
    recordMigration(db, 17, "project intelligence radar evaluation and budgets");
  })();
};
