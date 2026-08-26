import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applySkillCommissionRevisionMigration: StateMigration = (db) => {
  if (hasMigration(db, 4)) return;
  db.transaction(() => {
    const columns = new Set((db.query("PRAGMA table_info(skill_commissions)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!columns.has("revision")) {
      db.exec("ALTER TABLE skill_commissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    recordMigration(db, 4, "skill commission optimistic concurrency");
  })();
};
