import type { Database } from "bun:sqlite";

export type StateMigration = (db: Database) => void;

export function hasMigration(db: Database, version: number): boolean {
  return Boolean(db.query("SELECT version FROM schema_migrations WHERE version = ?").get(version));
}

export function recordMigration(db: Database, version: number, name: string): void {
  db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
    .run(version, name, new Date().toISOString());
}
