import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type { IntelligenceDomain } from "../intelligence-candidate-store";
import {
  LegacyIntelligenceEvidenceRepository,
  type LegacyIntelligenceEvidenceBundle,
  type LegacyIntelligenceEvidenceSeed,
} from "../repositories/legacy-intelligence-evidence-repository";
import { sha256FrozenSqliteSnapshot } from "./frozen-sqlite-snapshot";

const MAX_SNAPSHOT_BYTES = 256 * 1_024 * 1_024;
const MAX_DELIVERED_ROWS = 20_000;
const DEFAULT_HISTORY_HOURS = 168;
const REQUIRED_COLUMNS = [
  "source", "source_id", "title", "url", "status", "discovered_at", "pushed_at",
] as const;

interface LegacyEvidenceRow {
  source: string;
  source_id: string;
  title: string;
  url: string;
  delivered_at: string;
}

export interface LegacyIntelligenceEvidenceImportReport {
  source_ref: string;
  source_sha256: string;
  source_row_count: number;
  delivered_rows: number;
  eligible_seeds: number;
  skipped_old: number;
  skipped_invalid: number;
  cutoff_at: string;
  apply_requested: boolean;
  applied: boolean;
  inserted_seeds: number;
}

export async function importLegacyIntelligenceEvidence(input: {
  domain: IntelligenceDomain;
  sourcePath: string;
  sourceRef: string;
  dataDir: string;
  apply: boolean;
  historyHours?: number;
  now?: Date;
}): Promise<LegacyIntelligenceEvidenceImportReport> {
  if (input.domain !== "ai" && input.domain !== "finance") {
    throw new Error("Legacy intelligence domain must be ai or finance");
  }
  validateSourceRef(input.sourceRef);
  const historyHours = input.historyHours ?? DEFAULT_HISTORY_HOURS;
  if (!Number.isSafeInteger(historyHours) || historyHours < 1 || historyHours > 8_760) {
    throw new Error("Legacy intelligence historyHours must be 1-8760");
  }
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Legacy intelligence import time is invalid");
  const cutoff = new Date(now.getTime() - historyHours * 3_600_000);
  const sha256 = await sha256FrozenSqliteSnapshot({
    sourcePath: input.sourcePath,
    label: `Legacy ${input.domain} intelligence import`,
    maximumBytes: MAX_SNAPSHOT_BYTES,
  });
  const built = buildBundle(input.sourcePath, input.sourceRef, input.domain, sha256, cutoff);
  const result = input.apply
    ? new LegacyIntelligenceEvidenceRepository(input.dataDir).importLegacy(built.bundle, now)
    : { applied: false, inserted_seeds: 0 };
  return {
    source_ref: input.sourceRef,
    source_sha256: sha256,
    source_row_count: built.bundle.source_row_count,
    delivered_rows: built.deliveredRows,
    eligible_seeds: built.bundle.seeds.length,
    skipped_old: built.skippedOld,
    skipped_invalid: built.skippedInvalid,
    cutoff_at: cutoff.toISOString(),
    apply_requested: input.apply,
    applied: result.applied,
    inserted_seeds: result.inserted_seeds,
  };
}

function buildBundle(
  sourcePath: string,
  sourceRef: string,
  domain: IntelligenceDomain,
  sha256: string,
  cutoff: Date,
): { bundle: LegacyIntelligenceEvidenceBundle; deliveredRows: number; skippedOld: number; skippedInvalid: number } {
  const db = new Database(sourcePath, { readonly: true, strict: true });
  try {
    validateSchema(db, domain);
    const sourceRowCount = (db.query("SELECT COUNT(*) count FROM messages").get() as { count: number }).count;
    const rows = evidenceQuery(db, domain).all(MAX_DELIVERED_ROWS + 1) as LegacyEvidenceRow[];
    if (rows.length > MAX_DELIVERED_ROWS) {
      throw new Error(`Legacy intelligence snapshot exceeds ${MAX_DELIVERED_ROWS} delivered rows`);
    }
    const seeds: LegacyIntelligenceEvidenceSeed[] = [];
    let skippedOld = 0;
    let skippedInvalid = 0;
    for (const row of rows) {
      const deliveredAt = parseIso(row.delivered_at);
      if (!deliveredAt) { skippedInvalid += 1; continue; }
      if (deliveredAt < cutoff) { skippedOld += 1; continue; }
      const seed = normalizeSeed(row, sourceRef, domain, deliveredAt);
      if (!seed) { skippedInvalid += 1; continue; }
      seeds.push(seed);
    }
    return {
      bundle: { source_ref: sourceRef, source_sha256: sha256, source_row_count: sourceRowCount, domain, seeds },
      deliveredRows: rows.length,
      skippedOld,
      skippedInvalid,
    };
  } finally { db.close(); }
}

function evidenceQuery(db: Database, domain: IntelligenceDomain) {
  return domain === "ai"
    ? db.query(`
        SELECT source,source_id,title,url,COALESCE(pushed_at,digest_at,discovered_at) delivered_at
        FROM messages WHERE status IN ('digest_sent','immediate')
        ORDER BY delivered_at,source,source_id LIMIT ?
      `)
    : db.query(`
        SELECT source,source_id,title,url,COALESCE(pushed_at,discovered_at) delivered_at
        FROM messages WHERE status IN ('digest_sent','immediate_sent')
        ORDER BY delivered_at,source,source_id LIMIT ?
      `);
}

function normalizeSeed(
  row: LegacyEvidenceRow,
  sourceRef: string,
  domain: IntelligenceDomain,
  deliveredAt: Date,
): LegacyIntelligenceEvidenceSeed | undefined {
  const source = row.source.trim();
  const sourceId = row.source_id.trim();
  const headline = row.title.trim();
  const url = safeHttpsUrl(row.url);
  if (!source || source.length > 200 || !sourceId || sourceId.length > 500
    || !headline || headline.length > 500 || !url) return undefined;
  const fingerprint = createHash("sha256")
    .update([domain, source, sourceId, url, deliveredAt.toISOString()].join("\0"))
    .digest("hex").slice(0, 24);
  return {
    legacy_ref: `${sourceRef}:evidence:${fingerprint}`,
    domain,
    source,
    source_id: sourceId,
    url,
    headline,
    delivered_at: deliveredAt.toISOString(),
  };
}

function validateSchema(db: Database, domain: IntelligenceDomain): void {
  const columns = new Set((db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  const required = domain === "ai" ? [...REQUIRED_COLUMNS, "digest_at"] : REQUIRED_COLUMNS;
  if (required.some((column) => !columns.has(column))) {
    throw new Error("Legacy intelligence snapshot has an unsupported messages schema");
  }
}

function parseIso(value: string): Date | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

function safeHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.href.length > 2_048) return undefined;
    return url.href;
  } catch { return undefined; }
}

function validateSourceRef(value: string): void {
  if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error("Legacy intelligence source_ref is invalid");
  }
}
