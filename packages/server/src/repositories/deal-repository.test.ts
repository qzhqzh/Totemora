import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dealId, type CollectedDeal, type DealItem } from "../domains/deals/deal";
import { DealRepository } from "./deal-repository";

function items(count: number): CollectedDeal[] {
  return Array.from({ length: count }, (_, index) => ({
    source_id: String(index + 1), title: `Deal ${index + 1}`, deal_text: `${index + 1} 元`,
    merchant: "商城", source_url: `https://example.com/${index + 1}`, source_rank: index + 1,
  }));
}

test("deal repository deduplicates, freezes five items, and terminalizes the remainder", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-deals-repository-"));
  try {
    const repository = new DealRepository(dataDir);
    expect(repository.storeCollected(items(6), "2026-08-30T10:00:00Z")).toBe(6);
    expect(repository.storeCollected(items(6), "2026-08-30T10:01:00Z")).toBe(0);
    const window = repository.createWindow("2026-08-30T18", 5, "2026-08-30T10:02:00Z");
    expect(window).toMatchObject({ status: "pending", item_count: 5, attempts: 0 });
    expect(repository.windowItems(window.window_key).map((item) => item.source_id))
      .toEqual(["1", "2", "3", "4", "5"]);
    expect(repository.recordDelivery({
      window_key: window.window_key, status: "completed", result: { accepted: true },
      now: "2026-08-30T10:03:00Z",
    })).toMatchObject({ status: "completed", attempts: 1 });
    expect(repository.summary().counts).toEqual({ pending: 0, delivered: 5, uncertain: 0, skipped: 1 });
    expect(repository.recordDelivery({ window_key: window.window_key, status: "failed" }).attempts).toBe(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("failed deal windows retry with the same selection and uncertain outcome is terminal", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-deals-retry-"));
  try {
    const repository = new DealRepository(dataDir);
    repository.storeCollected(items(1), "2026-08-30T10:00:00Z");
    const window = repository.createWindow("2026-08-30T18");
    repository.recordDelivery({ window_key: window.window_key, status: "failed", error: "offline" });
    expect(repository.oldestRetryableWindow()).toMatchObject({ window_key: window.window_key, attempts: 1 });
    expect(repository.windowItems(window.window_key)).toHaveLength(1);
    repository.recordDelivery({ window_key: window.window_key, status: "uncertain", result: { status: "uncertain" } });
    expect(repository.oldestRetryableWindow()).toBeUndefined();
    expect(repository.summary().counts.uncertain).toBe(1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("legacy deals import is atomic, repeatable, and detects changed snapshots", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-deals-import-"));
  try {
    const repository = new DealRepository(dataDir);
    const legacyItems: Array<DealItem & { legacy_ref: string }> = items(2).map((item, index) => ({
      ...item, id: dealId(item.source_id), status: index ? "skipped" : "delivered",
      discovered_at: "2026-08-30T08:00:00Z", updated_at: "2026-08-30T08:00:00Z",
      terminal_at: "2026-08-30T08:00:00Z", legacy_ref: `notice-ntfy:deals:item:${item.source_id}`,
    }));
    const bundle = { source_ref: "notice-ntfy:deals:d75fa2d", source_sha256: "a".repeat(64),
      source_row_count: 2, items: legacyItems };
    expect(repository.importLegacy(bundle)).toEqual({ applied: true, items: 2, inserted_items: 2 });
    expect(repository.importLegacy(bundle)).toEqual({ applied: false, items: 2, inserted_items: 0 });
    expect(() => repository.importLegacy({ ...bundle, source_sha256: "b".repeat(64) }))
      .toThrow("changed after import");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
