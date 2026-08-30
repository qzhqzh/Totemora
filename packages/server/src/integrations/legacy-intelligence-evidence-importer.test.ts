import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IntelligenceCandidateStore } from "../intelligence-candidate-store";
import { importLegacyIntelligenceEvidence } from "./legacy-intelligence-evidence-importer";

const now = new Date("2026-08-30T12:00:00.000Z");

test("legacy intelligence importer dry-runs, seeds recent deliveries, and remains idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-legacy-intelligence-"));
  const sourcePath = join(root, "hotspot.db");
  const dataDir = join(root, "target");
  createFixture(sourcePath, "ai");
  const input = {
    domain: "ai" as const,
    sourcePath,
    sourceRef: "notice-ntfy:hotspot:test",
    dataDir,
    historyHours: 168,
    now,
  };
  try {
    await expect(importLegacyIntelligenceEvidence({ ...input, apply: false })).resolves.toMatchObject({
      source_row_count: 4,
      delivered_rows: 3,
      eligible_seeds: 1,
      skipped_old: 1,
      skipped_invalid: 1,
      apply_requested: false,
      applied: false,
      inserted_seeds: 0,
    });
    await expect(importLegacyIntelligenceEvidence({ ...input, apply: true })).resolves.toMatchObject({
      applied: true,
      inserted_seeds: 1,
    });
    await expect(importLegacyIntelligenceEvidence({ ...input, apply: true })).resolves.toMatchObject({
      applied: false,
      inserted_seeds: 0,
    });

    const filtered = await new IntelligenceCandidateStore(dataDir).filterNovelEvidence({
      domain: "ai",
      history_hours: 168,
      now,
      evidence: [
        { title: "OpenAI 发布关键智能体协议", link: "https://example.com/new-url" },
        { title: "完全不同的新消息", link: "https://example.com/new" },
      ],
    });
    expect(filtered.suppressed).toHaveLength(1);
    expect(filtered.suppressed[0]!.candidate_id).toStartWith("legacy:");
    expect(filtered.novel).toEqual([{ title: "完全不同的新消息", link: "https://example.com/new" }]);

    appendRejectedRow(sourcePath, "ai");
    await expect(importLegacyIntelligenceEvidence({ ...input, apply: true }))
      .rejects.toThrow("changed after cutover");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy finance importer recognizes finance terminal statuses without digest columns", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-legacy-finance-"));
  const sourcePath = join(root, "finance.db");
  createFixture(sourcePath, "finance");
  try {
    await expect(importLegacyIntelligenceEvidence({
      domain: "finance",
      sourcePath,
      sourceRef: "notice-ntfy:finance:test",
      dataDir: join(root, "target"),
      historyHours: 168,
      now,
      apply: false,
    })).resolves.toMatchObject({ delivered_rows: 3, eligible_seeds: 1, skipped_old: 1, skipped_invalid: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

function createFixture(path: string, domain: "ai" | "finance"): void {
  const db = new Database(path, { create: true, strict: true });
  const digestColumn = domain === "ai" ? ",digest_at TEXT" : "";
  const recentStatus = domain === "ai" ? "immediate" : "immediate_sent";
  const digestStatus = "digest_sent";
  db.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE messages(
      id INTEGER PRIMARY KEY,source TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,
      url TEXT NOT NULL,status TEXT NOT NULL,discovered_at TEXT NOT NULL,pushed_at TEXT${digestColumn}
    );
  `);
  const insert = domain === "ai"
    ? db.query("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)")
    : db.query("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)");
  insert.run(1, "source", "recent", "OpenAI 发布重要智能体协议", "https://example.com/recent", recentStatus,
    "2026-08-30T08:00:00Z", "2026-08-30T08:00:00Z", ...(domain === "ai" ? [null] : []));
  insert.run(2, "source", "old", "Old", "https://example.com/old", digestStatus,
    "2026-08-20T08:00:00Z", null, ...(domain === "ai" ? ["2026-08-20T08:00:00Z"] : []));
  insert.run(3, "source", "http", "Unsafe URL", "http://example.com/http", digestStatus,
    "2026-08-30T09:00:00Z", "2026-08-30T09:00:00Z", ...(domain === "ai" ? [null] : []));
  insert.run(4, "source", "rejected", "Rejected", "https://example.com/rejected", "rejected",
    "2026-08-30T10:00:00Z", null, ...(domain === "ai" ? [null] : []));
  db.close();
}

function appendRejectedRow(path: string, domain: "ai" | "finance"): void {
  const db = new Database(path, { strict: true });
  const values = domain === "ai"
    ? [5, "source", "changed", "Changed", "https://example.com/changed", "rejected", "2026-08-30T11:00:00Z", null, null]
    : [5, "source", "changed", "Changed", "https://example.com/changed", "rejected", "2026-08-30T11:00:00Z", null];
  db.query(`INSERT INTO messages VALUES(${values.map(() => "?").join(",")})`).run(...values);
  db.close();
}
