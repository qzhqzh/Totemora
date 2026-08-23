import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applySkillTrialLeaseFencingMigration: StateMigration = (db) => {
  if (hasMigration(db, 6)) return;
  db.transaction(() => {
    const columns = new Set((db.query("PRAGMA table_info(skill_trial_run_leases)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!columns.has("claim_token")) db.exec("ALTER TABLE skill_trial_run_leases ADD COLUMN claim_token TEXT");
    if (!columns.has("lease_expires_at")) db.exec("ALTER TABLE skill_trial_run_leases ADD COLUMN lease_expires_at TEXT");
    recordMigration(db, 6, "skill trial lease fencing");
  })();
};
