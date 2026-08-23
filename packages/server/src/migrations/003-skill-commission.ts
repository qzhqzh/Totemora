import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applySkillCommissionMigration: StateMigration = (db) => {
  if (hasMigration(db, 3)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_commissions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        chief_member_id TEXT NOT NULL,
        target_member_id TEXT,
        target_service_id TEXT,
        risk TEXT NOT NULL,
        package_json TEXT,
        package_digest TEXT,
        package_version INTEGER,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skill_commission_status
        ON skill_commissions(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS skill_commission_messages (
        id TEXT PRIMARY KEY,
        commission_id TEXT NOT NULL REFERENCES skill_commissions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skill_commission_message_timeline
        ON skill_commission_messages(commission_id, created_at, id);
      CREATE TABLE IF NOT EXISTS skill_trials (
        id TEXT PRIMARY KEY,
        commission_id TEXT NOT NULL REFERENCES skill_commissions(id),
        baseline_evidence_id TEXT NOT NULL,
        trial_evidence_id TEXT NOT NULL,
        reviewer_member_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected')),
        metrics_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(commission_id, trial_evidence_id)
      );
      CREATE TABLE IF NOT EXISTS skill_activations (
        id TEXT PRIMARY KEY,
        commission_id TEXT NOT NULL REFERENCES skill_commissions(id),
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        digest TEXT NOT NULL,
        target_member_id TEXT,
        target_service_id TEXT,
        package_json TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skill_activation_lookup
        ON skill_activations(skill_id, status, version DESC);
    `);
    recordMigration(db, 3, "conversational skill commissions");
  })();
};
