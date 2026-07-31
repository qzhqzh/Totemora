import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

import { loadLocalConfig } from "@totemora/core";
import { ConfiguredProviderRegistry } from "@totemora/providers";

import { ActionJournal } from "./action-journal";
import { DevelopmentCommitService } from "./development-service";
import { IntelligenceCandidateStore } from "./intelligence-candidate-store";
import { IntelligencePreferenceStore } from "./intelligence-preference-store";
import { IntelligenceService } from "./intelligence-service";
import { JobStore } from "./job-store";
import { MemberConversationService } from "./member-conversation-service";
import { MemberStateStore } from "./member-state-store";
import { SettlementStore } from "./settlement-store";
import { StateDatabase } from "./state-database";
import { ToolAssetRegistry } from "./tool-asset-registry";

const command = process.argv[2] ?? "verify";
const configDir = resolve(process.env.TOTEMORA_CONFIG_DIR ?? "configs/example");
const dataDir = resolve(process.env.TOTEMORA_DATA_DIR ?? ".totemora");
const projectRoot = resolve(import.meta.dir, "../../..");
const databasePath = resolve(dataDir, "totemora.db");

if (!["migrate", "verify"].includes(command)) {
  console.error("Usage: bun run storage:migrate | bun run storage:verify");
  process.exit(2);
}

verifyExistingDatabase(databasePath);

const config = await loadLocalConfig({ configDir });
const providers = new ConfiguredProviderRegistry(config);
const settlement = new SettlementStore(dataDir);
const memberState = new MemberStateStore(dataDir, config);

new JobStore(dataDir, "jobs");
new JobStore(dataDir, "development-tasks");
new JobStore(dataDir, "intelligence-tasks");
new IntelligenceCandidateStore(dataDir);
new ActionJournal(dataDir);
new IntelligencePreferenceStore(dataDir);
new ToolAssetRegistry(projectRoot, dataDir);
new MemberConversationService(config, providers, memberState, dataDir);
new DevelopmentCommitService(config, providers, settlement, dataDir, projectRoot);
new IntelligenceService(config, providers, memberState, dataDir, projectRoot);

const state = StateDatabase.open(dataDir);
const source = {
  candidates: arrayLength(resolve(dataDir, "intelligence-candidates.json")),
  actions: arrayLength(resolve(dataDir, "action-journal.json")),
  briefs: jsonFileCount(resolve(dataDir, "intelligence-briefs")),
  schedule_lease_files: jsonFileCount(resolve(dataDir, "intelligence-schedule-leases")),
  schedule_leases: uniqueLeaseCount(resolve(dataDir, "intelligence-schedule-leases")),
  member_memory: arrayLength(resolve(dataDir, "member-memory.json"))
    + jsonArrayRows(resolve(dataDir, "member-memory")),
  member_experience: jsonArrayRows(resolve(dataDir, "member-experience")),
};
const database = {
  candidates: count(state, "intelligence_candidates"),
  actions: count(state, "action_journal"),
  briefs: countRecords(state, "intelligence_briefs"),
  schedule_leases: count(state, "schedule_leases"),
  member_events: count(state, "member_events"),
  growth_credit: Number((state.db.query(`
    SELECT COALESCE(SUM(credit_value),0) total FROM member_events
    WHERE verified=1 AND credit_type IN ('task_outcome','user_feedback')
  `).get() as { total: number }).total.toFixed(2)),
  imported_sources: count(state, "legacy_imports"),
};
const quickCheck = (state.db.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>)
  .map((row) => String(Object.values(row)[0]));
const foreignKeyViolations = state.db.query("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
const integrity = {
  quick_check: quickCheck,
  foreign_key_violations: foreignKeyViolations.length,
};
const checks = [
  ["candidates", database.candidates >= source.candidates],
  ["actions", database.actions >= source.actions],
  ["briefs", database.briefs >= source.briefs],
  ["schedule_leases", database.schedule_leases >= source.schedule_leases],
  ["sqlite_quick_check", quickCheck.length === 1 && quickCheck[0] === "ok"],
  ["sqlite_foreign_keys", foreignKeyViolations.length === 0],
] as const;
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(JSON.stringify({ ok: false, failed, source, database }, null, 2));
  process.exit(1);
}
if (command === "migrate") {
  state.putRecord("state", "storage_cutover", {
    backend: "sqlite", version: 1, migrated_at: new Date().toISOString(),
    source_snapshot: source, database_snapshot: database,
    note: "Legacy JSON is retained read-only; runtime writes now go only to SQLite.",
  });
}
console.log(JSON.stringify({
  ok: true, command, database_path: state.path, source, database, integrity,
  semantic_note: "member_events preserves imported history; growth_credit excludes scans and system failures.",
}, null, 2));

function arrayLength(path: string): number {
  if (!existsSync(path)) return 0;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error(`Expected array: ${path}`);
  return value.length;
}

function jsonFileCount(directory: string): number {
  try { return readdirSync(directory).filter((file) => file.endsWith(".json")).length; }
  catch { return 0; }
}

function jsonArrayRows(directory: string): number {
  try {
    return readdirSync(directory).filter((file) => file.endsWith(".json"))
      .reduce((total, file) => total + arrayLength(resolve(directory, file)), 0);
  } catch { return 0; }
}

function uniqueLeaseCount(directory: string): number {
  try {
    return new Set(readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => {
      const value = JSON.parse(readFileSync(resolve(directory, file), "utf8")) as { window?: string; hour?: string };
      const key = value.window ?? value.hour;
      if (!key) throw new Error(`Schedule lease has no window or hour: ${file}`);
      return key;
    })).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function verifyExistingDatabase(path: string): void {
  if (!existsSync(path)) return;
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const quickCheck = (database.query("PRAGMA quick_check").all() as Array<Record<string, unknown>>)
      .map((row) => String(Object.values(row)[0]));
    const foreignKeyViolations = database.query("PRAGMA foreign_key_check").all();
    if (quickCheck.length !== 1 || quickCheck[0] !== "ok" || foreignKeyViolations.length > 0) {
      console.error(JSON.stringify({
        ok: false,
        phase: "preflight",
        database_path: path,
        integrity: { quick_check: quickCheck, foreign_key_violations: foreignKeyViolations.length },
      }, null, 2));
      process.exit(1);
    }
  } finally {
    database.close();
  }
}

function count(state: StateDatabase, table: string): number {
  return (state.db.query(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count;
}

function countRecords(state: StateDatabase, namespace: string): number {
  return (state.db.query("SELECT COUNT(*) count FROM records WHERE namespace=?").get(namespace) as { count: number }).count;
}
