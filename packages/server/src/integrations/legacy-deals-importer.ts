import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { dealId, normalizeCollectedDeal, type DealItem } from "../domains/deals/deal";
import { DealRepository, type LegacyDealImportBundle } from "../repositories/deal-repository";
import { sha256FrozenSqliteSnapshot } from "./frozen-sqlite-snapshot";

const MAX_SNAPSHOT_BYTES = 128 * 1_024 * 1_024;
const MAX_ITEMS = 20_000;
const REQUIRED_SCHEMA = {
  items: ["source_id", "title", "deal", "mall", "url", "image", "discovered_at", "source_rank", "status"],
  runs: ["id", "kind", "started_at", "finished_at", "status", "detail"],
} as const;

interface LegacyDealRow {
  source_id: string;
  title: string;
  deal: string | null;
  mall: string | null;
  url: string;
  image: string | null;
  discovered_at: string;
  source_rank: number;
  status: string;
}

export interface LegacyDealsImportReport {
  source_ref: string;
  source_sha256: string;
  source_row_count: number;
  items: number;
  delivered_seeds: number;
  skipped_seeds: number;
  apply_requested: boolean;
  applied: boolean;
  inserted_items: number;
}

export async function importLegacyDealsSnapshot(input: {
  sourcePath: string;
  sourceRef: string;
  dataDir: string;
  apply: boolean;
}): Promise<LegacyDealsImportReport> {
  validateSourceRef(input.sourceRef);
  const sha256 = await sha256FrozenSqliteSnapshot({
    sourcePath: input.sourcePath,
    label: "Legacy deals import",
    maximumBytes: MAX_SNAPSHOT_BYTES,
  });
  const bundle = buildBundle(input.sourcePath, input.sourceRef, sha256);
  const result = input.apply
    ? new DealRepository(input.dataDir).importLegacy(bundle)
    : { applied: false, inserted_items: 0 };
  return {
    source_ref: bundle.source_ref,
    source_sha256: sha256,
    source_row_count: bundle.source_row_count,
    items: bundle.items.length,
    delivered_seeds: bundle.items.filter((item) => item.status === "delivered").length,
    skipped_seeds: bundle.items.filter((item) => item.status === "skipped").length,
    apply_requested: input.apply,
    applied: result.applied,
    inserted_items: result.inserted_items,
  };
}

function buildBundle(sourcePath: string, sourceRef: string, sha256: string): LegacyDealImportBundle {
  const db = new Database(sourcePath, { readonly: true, strict: true });
  try {
    validateSchema(db);
    const sourceRowCount = Object.keys(REQUIRED_SCHEMA).reduce((total, table) => {
      return total + (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    }, 0);
    const rows = db.query(`
      SELECT source_id,title,deal,mall,url,image,discovered_at,source_rank,status
      FROM items ORDER BY discovered_at,source_id LIMIT ?
    `).all(MAX_ITEMS + 1) as LegacyDealRow[];
    if (rows.length > MAX_ITEMS) throw new Error(`Legacy deals snapshot exceeds ${MAX_ITEMS} items`);
    return {
      source_ref: sourceRef,
      source_sha256: sha256,
      source_row_count: sourceRowCount,
      items: rows.map((row) => legacyItem(row, sourceRef)),
    };
  } finally { db.close(); }
}

function legacyItem(row: LegacyDealRow, sourceRef: string): DealItem & { legacy_ref: string } {
  const timestamp = validIso(row.discovered_at);
  const item = normalizeCollectedDeal({
    source_id: row.source_id,
    title: row.title,
    deal_text: row.deal ?? "",
    merchant: row.mall ?? "",
    source_url: row.url,
    ...(row.image?.startsWith("https://") ? { image_url: row.image } : {}),
    source_rank: row.source_rank,
  });
  const status = row.status === "sent" ? "delivered"
    : row.status === "skipped" || row.status === "pending" ? "skipped" : undefined;
  if (!status) throw new Error(`Legacy deal status is unsupported: ${row.status}`);
  return {
    ...item,
    id: dealId(item.source_id),
    status,
    discovered_at: timestamp,
    updated_at: timestamp,
    terminal_at: timestamp,
    legacy_ref: `${sourceRef}:item:${createHash("sha256").update(item.source_id).digest("hex").slice(0, 24)}`,
  };
}

function validateSchema(db: Database): void {
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (required.some((column) => !columns.has(column))) {
      throw new Error(`Legacy deals snapshot has an unsupported ${table} schema`);
    }
  }
}

function validIso(value: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error("Legacy deal discovered_at is invalid");
  return new Date(value).toISOString();
}

function validateSourceRef(value: string): void {
  if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error("Legacy deals source_ref is invalid");
  }
}
