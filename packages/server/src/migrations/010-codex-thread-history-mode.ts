import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyCodexThreadHistoryModeMigration: StateMigration = (db) => {
  if (hasMigration(db, 10)) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE codex_threads
      ADD COLUMN history_mode TEXT
      CHECK(history_mode IS NULL OR history_mode IN ('legacy','paginated'));
    `);
    recordMigration(db, 10, "record Codex thread history mode");
  })();
};
