import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RunStore, TribeRun } from "./types";

export class FileRunStore implements RunStore {
  readonly runsDir: string;

  constructor(dataDir = process.env.TOTEMORA_DATA_DIR ?? ".totemora") {
    this.runsDir = resolve(dataDir, "runs");
  }

  async save(run: TribeRun): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    await writeFile(
      join(this.runsDir, `${run.id}.json`),
      `${JSON.stringify(run, null, 2)}\n`,
      "utf8",
    );
  }
}
