import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { parseNotificationIngressConfig } from "./notification-ingress-config";
import type { NotificationIngressConfig } from "../domains/notification/notification-ingress-contract";

type ManagedKey = "sources" | "rules" | "bark" | "email" | "smtp";
export type AdminConfigPatch = Partial<Pick<NotificationIngressConfig, ManagedKey>>;
const FIELDS: ManagedKey[] = ["sources", "rules", "bark", "email", "smtp"];
const MAX_BYTES = 64 * 1024;

/** Private, atomic overlay: mounted input files remain read-only and never become a second writer. */
export class AdminConfigStore {
  private pending: Promise<void> = Promise.resolve();
  private constructor(private readonly base: NotificationIngressConfig,
    private readonly directory: string, private values: AdminConfigPatch, public revision: string,
    public config: NotificationIngressConfig) {}

  static async open(dataDir: string, base: NotificationIngressConfig): Promise<AdminConfigStore> {
    const directory = resolve(dataDir, "secrets");
    const path = resolve(directory, "notification-admin.json");
    let values: AdminConfigPatch = {};
    let revision = `base-${createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 24)}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (!nodeError(error, "ENOENT")) throw new Error("Cannot safely read Notifier admin config");
    }
    if (handle) {
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) || info.size > MAX_BYTES) {
          throw new Error("Notifier admin config must be a private regular file <= 64 KiB");
        }
        const raw = await handle.readFile("utf8");
        if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Notifier admin config is too large");
        const stored: unknown = JSON.parse(raw);
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("Invalid admin config");
        const record = stored as Record<string, unknown>;
        if (record.schema_version !== 1 || typeof record.revision !== "string"
          || !/^[0-9a-f-]{36}$/.test(record.revision) || !record.values
          || typeof record.values !== "object" || Array.isArray(record.values)
          || Object.keys(record).some((key) => !["schema_version", "revision", "values"].includes(key))
          || Object.keys(record.values).some((key) => !FIELDS.includes(key as ManagedKey))) {
          throw new Error("Invalid Notifier admin config overlay");
        }
        values = record.values as AdminConfigPatch;
        revision = record.revision;
      } finally { await handle.close(); }
    }
    return new AdminConfigStore(base, directory, values, revision, merge(base, values));
  }

  async update<T>(expectedRevision: string, change: (config: NotificationIngressConfig) => AdminConfigPatch,
    prepare: (config: NotificationIngressConfig) => Promise<T>,
    commit: (config: NotificationIngressConfig, prepared: T) => void): Promise<void> {
    const operation = this.pending.then(async () => {
      if (expectedRevision !== this.revision) throw new AdminConfigConflictError();
      const patch = change(this.config);
      if (!patch || Object.keys(patch).some((key) => !FIELDS.includes(key as ManagedKey))) {
        throw new Error("Invalid admin config update");
      }
      const values = { ...this.values, ...patch };
      const config = merge(this.base, values);
      const prepared = await prepare(config);
      const revision = randomUUID();
      await this.save({ schema_version: 1, revision, values });
      this.values = values;
      this.config = config;
      this.revision = revision;
      commit(config, prepared);
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }

  private async save(record: { schema_version: 1; revision: string; values: AdminConfigPatch }): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(this.directory);
    if (!dir.isDirectory() || (dir.mode & 0o077)) throw new Error("Notifier secrets directory must be private");
    const path = resolve(this.directory, "notification-admin.json");
    try {
      const previous = await lstat(path);
      if (!previous.isFile() || (previous.mode & 0o077)) throw new Error("Notifier admin config is not a private regular file");
    } catch (error) { if (!nodeError(error, "ENOENT")) throw error; }
    const body = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Notifier admin config is too large");
    const temporary = resolve(this.directory, `.notification-admin-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

export class AdminConfigConflictError extends Error {
  constructor() { super("Configuration changed; reload before saving"); }
}

function merge(base: NotificationIngressConfig, values: AdminConfigPatch): NotificationIngressConfig {
  return parseNotificationIngressConfig({ schema_version: 1, ...base, ...values });
}

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
