import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyIntelligenceDomainMigration: StateMigration = (db) => {
  if (hasMigration(db, 2)) return;
  db.transaction(() => {
    const columns = new Set((db.query("PRAGMA table_info(intelligence_candidates)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!columns.has("domain")) db.exec("ALTER TABLE intelligence_candidates ADD COLUMN domain TEXT NOT NULL DEFAULT 'ai'");
    if (!columns.has("market")) db.exec("ALTER TABLE intelligence_candidates ADD COLUMN market TEXT");
    if (!columns.has("symbols_json")) db.exec("ALTER TABLE intelligence_candidates ADD COLUMN symbols_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has("event_type")) db.exec("ALTER TABLE intelligence_candidates ADD COLUMN event_type TEXT");
    if (!columns.has("evidence_tier")) db.exec("ALTER TABLE intelligence_candidates ADD COLUMN evidence_tier TEXT");
    if (!columns.has("source_id")) db.exec("ALTER TABLE intelligence_candidates ADD COLUMN source_id TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS candidate_domain_dispatch
        ON intelligence_candidates(domain, status, next_attempt_at, total DESC, created_at);
      CREATE INDEX IF NOT EXISTS candidate_domain_event_history
        ON intelligence_candidates(domain, event_key, created_at DESC);
    `);
    recordMigration(db, 2, "domain-aware intelligence candidates");
  })();
};
