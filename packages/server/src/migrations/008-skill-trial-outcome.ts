import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applySkillTrialOutcomeMigration: StateMigration = (db) => {
  if (hasMigration(db, 8)) return;
  db.transaction(() => {
    const invalidTrials = db.query(`
      SELECT * FROM skill_trials WHERE outcome NOT IN ('accepted','rejected')
    `).all() as Array<Record<string, unknown> & { id: string; created_at: string }>;
    for (const trial of invalidTrials) {
      const quarantined = {
        reason: "invalid_outcome_before_migration_8",
        trial,
      };
      db.query(`
        INSERT INTO records(namespace,id,payload_json,created_at,updated_at)
        VALUES('quarantined_skill_trials',?,?,?,?)
        ON CONFLICT(namespace,id) DO UPDATE SET
          payload_json=excluded.payload_json,updated_at=excluded.updated_at
      `).run(trial.id, JSON.stringify(quarantined), trial.created_at, new Date().toISOString());
      db.query("DELETE FROM skill_trials WHERE id=?").run(trial.id);
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS skill_trials_valid_outcome_insert
      BEFORE INSERT ON skill_trials
      WHEN NEW.outcome NOT IN ('accepted','rejected')
      BEGIN
        SELECT RAISE(ABORT, 'invalid skill trial outcome');
      END;
      CREATE TRIGGER IF NOT EXISTS skill_trials_valid_outcome_update
      BEFORE UPDATE OF outcome ON skill_trials
      WHEN NEW.outcome NOT IN ('accepted','rejected')
      BEGIN
        SELECT RAISE(ABORT, 'invalid skill trial outcome');
      END;
    `);
    recordMigration(db, 8, "constrain skill trial outcomes");
  })();
};
