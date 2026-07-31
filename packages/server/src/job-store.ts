import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { StateDatabase } from "./state-database";

export interface PersistedJob<TJob, TInput> {
  job: TJob;
  input: TInput;
}

export class JobStore<TJob extends { id: string; created_at?: string; updated_at?: string }, TInput> {
  private readonly state: StateDatabase;
  private readonly namespace: string;

  constructor(private readonly dataDir: string, namespace = "jobs") {
    this.state = StateDatabase.open(dataDir);
    this.namespace = `jobs:${namespace}`;
    this.importLegacy(namespace);
  }

  async save(job: TJob, input: TInput): Promise<void> {
    this.state.putRecord(
      this.namespace, job.id, structuredClone({ job, input }),
      job.created_at, job.updated_at,
    );
  }

  async list(): Promise<Array<PersistedJob<TJob, TInput>>> {
    return this.state.listRecords<PersistedJob<TJob, TInput>>(this.namespace);
  }

  private importLegacy(directoryName: string): void {
    const directory = resolve(this.dataDir, directoryName);
    let files: string[];
    try { files = readdirSync(directory).filter((file) => file.endsWith(".json")); }
    catch { return; }
    for (const file of files) {
      const source = resolve(directory, file);
      this.state.importJsonFile<PersistedJob<TJob, TInput>>(
        source,
        (value) => [value as PersistedJob<TJob, TInput>],
        (value) => this.state.putRecord(
          this.namespace, value.job.id, value,
          value.job.created_at, value.job.updated_at,
        ),
      );
    }
  }
}
