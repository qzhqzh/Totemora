import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { runStateMigrations } from "./migrations";

const instances = new Map<string, StateDatabase>();

export interface LegacyImportResult {
  imported: boolean;
  row_count: number;
}

export class StateDatabase {
  readonly db: Database;

  static open(dataDir: string): StateDatabase {
    const path = resolve(dataDir, "totemora.db");
    let instance = instances.get(path);
    if (!instance) {
      instance = new StateDatabase(path);
      instances.set(path, instance);
    }
    return instance;
  }

  private constructor(readonly path: string) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    runStateMigrations(this.db);
  }

  importJsonFile<T>(sourcePath: string, parse: (value: unknown) => T[], insert: (row: T) => void): LegacyImportResult {
    let bytes: Buffer;
    try {
      if (!statSync(sourcePath).isFile()) return { imported: false, row_count: 0 };
      bytes = readFileSync(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imported: false, row_count: 0 };
      throw error;
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.query("SELECT sha256,row_count FROM legacy_imports WHERE source_path = ?").get(sourcePath) as {
      sha256: string; row_count: number;
    } | null;
    if (existing) {
      if (existing.sha256 !== hash) {
        throw new Error(`Legacy state changed after SQLite cutover: ${sourcePath}`);
      }
      return { imported: false, row_count: existing.row_count };
    }
    let rows: T[];
    try {
      rows = parse(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      throw new Error(`Cannot import legacy JSON ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.db.transaction(() => {
      for (const row of rows) insert(row);
      this.db.query("INSERT INTO legacy_imports(source_path,sha256,row_count,imported_at) VALUES(?,?,?,?)")
        .run(sourcePath, hash, rows.length, new Date().toISOString());
    })();
    return { imported: true, row_count: rows.length };
  }

  putRecord(namespace: string, id: string, value: unknown, createdAt?: string, updatedAt?: string): void {
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO records(namespace,id,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(namespace,id) DO UPDATE SET
        payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `).run(namespace, id, JSON.stringify(value), createdAt ?? now, updatedAt ?? now);
  }

  listRecords<T>(namespace: string): T[] {
    return (this.db.query("SELECT payload_json FROM records WHERE namespace = ? ORDER BY updated_at DESC").all(namespace) as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json) as T);
  }
}
