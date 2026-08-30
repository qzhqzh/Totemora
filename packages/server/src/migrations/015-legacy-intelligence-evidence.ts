import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyLegacyIntelligenceEvidenceMigration: StateMigration = (db) => {
  if (hasMigration(db, 15)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE legacy_intelligence_imports(
        source_ref TEXT PRIMARY KEY CHECK(length(source_ref) BETWEEN 1 AND 200),
        domain TEXT NOT NULL CHECK(domain IN ('ai','finance')),
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
        source_row_count INTEGER NOT NULL CHECK(source_row_count >= 0),
        seed_count INTEGER NOT NULL CHECK(seed_count >= 0),
        imported_at TEXT NOT NULL,
        UNIQUE(source_ref,domain)
      );

      CREATE TABLE legacy_intelligence_evidence(
        legacy_ref TEXT PRIMARY KEY CHECK(length(legacy_ref) BETWEEN 1 AND 240),
        domain TEXT NOT NULL CHECK(domain IN ('ai','finance')),
        source_ref TEXT NOT NULL,
        source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 200),
        source_id TEXT CHECK(source_id IS NULL OR length(source_id) BETWEEN 1 AND 500),
        url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048),
        headline TEXT NOT NULL CHECK(length(headline) BETWEEN 1 AND 500),
        delivered_at TEXT NOT NULL,
        FOREIGN KEY(source_ref,domain) REFERENCES legacy_intelligence_imports(source_ref,domain)
      );
      CREATE INDEX legacy_intelligence_evidence_domain_delivered_idx
        ON legacy_intelligence_evidence(domain,delivered_at DESC);
    `);
    recordMigration(db, 15, "legacy intelligence delivery evidence");
  })();
};
