import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PersistedJob<TJob, TInput> {
  job: TJob;
  input: TInput;
}

export class JobStore<TJob extends { id: string }, TInput> {
  private readonly directory: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(dataDir: string, namespace = "jobs") {
    this.directory = resolve(dataDir, namespace);
  }

  async save(job: TJob, input: TInput): Promise<void> {
    const snapshot = structuredClone({ job, input });
    const operation = (this.queues.get(job.id) ?? Promise.resolve()).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const target = join(this.directory, `${job.id}.json`);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rename(temporary, target);
    });
    this.queues.set(job.id, operation.catch(() => undefined));
    await operation;
  }

  async list(): Promise<Array<PersistedJob<TJob, TInput>>> {
    let files: string[];
    try {
      files = (await readdir(this.directory)).filter((file) => file.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(files.map(async (file) => {
      try {
        return JSON.parse(await readFile(join(this.directory, file), "utf8")) as PersistedJob<TJob, TInput>;
      } catch {
        return undefined;
      }
    }));
    return records.filter((record) => record !== undefined);
  }
}
