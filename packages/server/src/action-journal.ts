import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ActionRecord {
  id: string;
  idempotency_key: string;
  asset_id: string;
  member_id: string;
  action: string;
  request_hash: string;
  status: "executing" | "completed" | "failed";
  attempts: number;
  started_at: string;
  updated_at: string;
  evidence?: string;
  error?: string;
}

export class ActionJournal {
  private readonly path: string;
  private queue = Promise.resolve();

  constructor(dataDir: string) {
    this.path = resolve(dataDir, "action-journal.json");
  }

  async executeOnce<T>(input: {
    idempotency_key: string;
    asset_id: string;
    member_id: string;
    action: string;
    request: unknown;
  }, operation: () => Promise<T>, evidence: (result: T) => string): Promise<{ result: T; record: ActionRecord; replayed: boolean }> {
    const requestHash = createHash("sha256").update(JSON.stringify(input.request)).digest("hex");
    const existing = (await this.list()).find((item) => item.idempotency_key === input.idempotency_key);
    if (existing?.status === "completed") {
      throw new Error(`Action already completed for idempotency key ${input.idempotency_key}`);
    }
    if (existing?.status === "executing") {
      throw new Error(`Action is already executing for idempotency key ${input.idempotency_key}`);
    }
    if (existing && existing.request_hash !== requestHash) {
      throw new Error("Idempotency key was reused with a different request");
    }
    const now = new Date().toISOString();
    const record: ActionRecord = existing ?? {
      id: crypto.randomUUID(), idempotency_key: input.idempotency_key,
      asset_id: input.asset_id, member_id: input.member_id, action: input.action,
      request_hash: requestHash, status: "executing", attempts: 0,
      started_at: now, updated_at: now,
    };
    record.status = "executing";
    record.attempts += 1;
    record.updated_at = now;
    record.error = undefined;
    await this.upsert(record);
    try {
      const result = await operation();
      record.status = "completed";
      record.evidence = evidence(result).slice(0, 4_000);
      record.updated_at = new Date().toISOString();
      await this.upsert(record);
      return { result, record, replayed: false };
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.updated_at = new Date().toISOString();
      await this.upsert(record);
      throw error;
    }
  }

  async list(): Promise<ActionRecord[]> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as ActionRecord[]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async upsert(record: ActionRecord): Promise<void> {
    const operation = this.queue.then(async () => {
      const records = await this.list();
      const index = records.findIndex((item) => item.id === record.id);
      if (index >= 0) records[index] = structuredClone(record);
      else records.push(structuredClone(record));
      await atomicWrite(this.path, records.slice(-1_000));
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
