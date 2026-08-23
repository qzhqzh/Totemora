import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applySkillTrialRunLeaseMigration: StateMigration = (db) => {
  if (hasMigration(db, 5)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_trial_run_leases (
        commission_id TEXT PRIMARY KEY,
        run_id TEXT UNIQUE NOT NULL,
        owner_id TEXT,
        claimed_at TEXT
      )
    `);
    recordMigration(db, 5, "skill trial active run reservation");
  })();
};
