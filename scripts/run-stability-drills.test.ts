import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runStabilityDrills } from "./run-stability-drills";

test("stability drill exercises production recovery and isolation boundaries without external network", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-stability-report-"));
  try {
    const output = await runStabilityDrills({
      dataDir,
      configDir: resolve(import.meta.dir, "../configs/example"),
    });
    expect(output.report.summary).toEqual({ attempted: 4, passed: 4, failed: 0 });
    expect(output.report.scenarios.map((item) => item.id)).toEqual([
      "provider-degradation",
      "recurring-isolation-and-restart",
      "gateway-task-restart",
      "bark-circuit-breaker",
    ]);
    const serialized = await readFile(output.jsonPath, "utf8");
    expect(serialized).not.toContain("drill-device-key");
    expect(await readFile(output.markdownPath, "utf8")).toContain("Passed: 4/4");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
