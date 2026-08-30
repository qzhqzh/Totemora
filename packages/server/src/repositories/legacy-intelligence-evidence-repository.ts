import { StateDatabase } from "../state-database";
import type { IntelligenceDomain } from "../intelligence-candidate-store";

export interface LegacyIntelligenceEvidenceSeed {
  legacy_ref: string;
  domain: IntelligenceDomain;
  source: string;
  source_id?: string;
  url: string;
  headline: string;
  delivered_at: string;
}

export interface LegacyIntelligenceEvidenceBundle {
  source_ref: string;
  source_sha256: string;
  source_row_count: number;
  domain: IntelligenceDomain;
  seeds: LegacyIntelligenceEvidenceSeed[];
}

export interface LegacyIntelligenceEvidenceImportResult {
  applied: boolean;
  inserted_seeds: number;
}

export class LegacyIntelligenceEvidenceRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  importLegacy(bundle: LegacyIntelligenceEvidenceBundle, now = new Date()): LegacyIntelligenceEvidenceImportResult {
    return this.state.db.transaction(() => {
      const existing = this.state.db.query(`
        SELECT domain,source_sha256,source_row_count,seed_count
        FROM legacy_intelligence_imports WHERE source_ref=?
      `).get(bundle.source_ref) as {
        domain: IntelligenceDomain;
        source_sha256: string;
        source_row_count: number;
        seed_count: number;
      } | null;
      if (existing) {
        if (existing.domain !== bundle.domain || existing.source_sha256 !== bundle.source_sha256
          || existing.source_row_count !== bundle.source_row_count || existing.seed_count !== bundle.seeds.length) {
          throw new Error(`Legacy intelligence snapshot changed after cutover: ${bundle.source_ref}`);
        }
        return { applied: false, inserted_seeds: 0 };
      }
      this.state.db.query(`
        INSERT INTO legacy_intelligence_imports(
          source_ref,domain,source_sha256,source_row_count,seed_count,imported_at
        ) VALUES(?,?,?,?,?,?)
      `).run(
        bundle.source_ref, bundle.domain, bundle.source_sha256,
        bundle.source_row_count, bundle.seeds.length, now.toISOString(),
      );
      const insert = this.state.db.query(`
        INSERT INTO legacy_intelligence_evidence(
          legacy_ref,domain,source_ref,source,source_id,url,headline,delivered_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `);
      for (const seed of bundle.seeds) {
        insert.run(
          seed.legacy_ref, seed.domain, bundle.source_ref, seed.source,
          seed.source_id ?? null, seed.url, seed.headline, seed.delivered_at,
        );
      }
      return { applied: true, inserted_seeds: bundle.seeds.length };
    })();
  }
}
