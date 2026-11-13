import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyProjectRadarActionsMigration: StateMigration = (db) => {
  if (hasMigration(db, 19)) return;
  db.transaction(() => {
    db.exec(`
      CREATE UNIQUE INDEX project_radar_evaluation_candidate ON project_radar_evaluations(id,candidate_id);
      CREATE TABLE project_radar_actions(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
        candidate_id TEXT NOT NULL REFERENCES intelligence_candidates(id),
        evaluation_id TEXT NOT NULL,
        project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 64 AND project_id NOT GLOB '*[^a-z0-9-]*'
          AND substr(project_id,1,1) GLOB '[a-z0-9]'),
        project_name TEXT NOT NULL CHECK(length(trim(project_name)) BETWEEN 1 AND 100),
        project_goal TEXT NOT NULL CHECK(length(trim(project_goal)) BETWEEN 1 AND 1000),
        title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 600),
        rationale TEXT NOT NULL CHECK(length(trim(rationale)) BETWEEN 1 AND 2000),
        next_step TEXT NOT NULL CHECK(length(trim(next_step)) BETWEEN 1 AND 2500),
        acceptance_criteria_json TEXT NOT NULL CHECK(json_valid(acceptance_criteria_json) AND json_type(acceptance_criteria_json)='array'
          AND json_array_length(acceptance_criteria_json) BETWEEN 1 AND 8 AND length(CAST(acceptance_criteria_json AS BLOB))<=48064),
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'
          AND json_array_length(evidence_json) BETWEEN 1 AND 3 AND length(CAST(evidence_json AS BLOB))<=49152),
        method TEXT NOT NULL CHECK(method IN ('rules','jev')),
        status TEXT NOT NULL CHECK(status IN ('proposed','accepted','dismissed')),
        created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 20 AND 40),
        decided_at TEXT CHECK(decided_at IS NULL OR length(decided_at) BETWEEN 20 AND 40),
        decision_source TEXT CHECK(decision_source IS NULL OR decision_source IN ('web','telegram')),
        UNIQUE(candidate_id,project_id),
        FOREIGN KEY(evaluation_id,candidate_id) REFERENCES project_radar_evaluations(id,candidate_id),
        CHECK((status='proposed' AND decided_at IS NULL AND decision_source IS NULL)
          OR (status IN ('accepted','dismissed') AND decided_at IS NOT NULL AND decision_source IS NOT NULL))
      );
      CREATE INDEX project_radar_actions_latest ON project_radar_actions(created_at DESC,id);
      CREATE TABLE project_radar_action_decisions(
        idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 128),
        action_id TEXT NOT NULL REFERENCES project_radar_actions(id),
        decision TEXT NOT NULL CHECK(decision IN ('accept','dismiss')),
        source TEXT NOT NULL CHECK(source IN ('web','telegram')),
        request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'),
        result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'
          AND length(CAST(result_json AS BLOB))<=65536 AND json_extract(result_json,'$.id') IS action_id
          AND json_extract(result_json,'$.status') IS CASE decision WHEN 'accept' THEN 'accepted' ELSE 'dismissed' END),
        created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 20 AND 40)
      );
      CREATE INDEX project_radar_action_decisions_action ON project_radar_action_decisions(action_id);
      CREATE TRIGGER project_radar_actions_decided_immutable BEFORE UPDATE ON project_radar_actions
        WHEN OLD.status!='proposed' BEGIN SELECT RAISE(ABORT,'decided project radar action is immutable'); END;
    `);
    for (const operation of ["INSERT", "UPDATE"]) db.exec(`
      CREATE TRIGGER project_radar_actions_validate_${operation.toLowerCase()} BEFORE ${operation} ON project_radar_actions
      BEGIN
        SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.acceptance_criteria_json)
          WHERE type!='text' OR length(trim(value)) NOT BETWEEN 1 AND 1500)
          THEN RAISE(ABORT,'invalid action acceptance criteria') END;
        SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.evidence_json)
          WHERE type!='object' OR json_type(value,'$.title') IS NOT 'text' OR length(trim(json_extract(value,'$.title'))) NOT BETWEEN 1 AND 500
            OR json_type(value,'$.url') IS NOT 'text' OR length(json_extract(value,'$.url')) NOT BETWEEN 9 AND 2048
            OR json_extract(value,'$.url') NOT LIKE 'https://%'
            OR json_type(value,'$.source') IS NOT 'text' OR length(trim(json_extract(value,'$.source'))) NOT BETWEEN 1 AND 200
            OR json_type(value,'$.excerpt') IS NOT 'text' OR length(trim(json_extract(value,'$.excerpt'))) NOT BETWEEN 1 AND 2000)
          THEN RAISE(ABORT,'invalid action evidence') END;
      END;
    `);
    recordMigration(db, 19, "project radar action suggestions and idempotent decisions");
  })();
};
