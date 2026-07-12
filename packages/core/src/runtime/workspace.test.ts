import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";

import { collectWorkspaceSnapshot } from "./workspace";

test("collects a bounded source snapshot without secrets or dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-workspace-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "demo"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Demo\n", "utf8");
    await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({ api_key: "sk-example-secret-value-123456789" }),
      "utf8",
    );
    await writeFile(join(root, ".env"), "SECRET=do-not-read\n", "utf8");
    await writeFile(
      join(root, "node_modules", "demo", "index.js"),
      "dependency",
      "utf8",
    );

    const snapshot = await collectWorkspaceSnapshot(root);

    expect(snapshot.files.map((file) => file.path)).toEqual([
      "README.md",
      "src/index.ts",
      "config.json",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("do-not-read");
    expect(JSON.stringify(snapshot)).not.toContain("sk-example-secret-value");
    expect(JSON.stringify(snapshot)).toContain("[REDACTED]");
    expect(snapshot.total_bytes).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncates large files and respects the total context budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-workspace-"));
  try {
    await writeFile(join(root, "README.md"), "a".repeat(200), "utf8");
    await writeFile(join(root, "notes.md"), "b".repeat(200), "utf8");

    const snapshot = await collectWorkspaceSnapshot(root, {
      maxFileBytes: 80,
      maxTotalBytes: 120,
    });

    expect(snapshot.files[0]?.truncated).toBe(true);
    expect(snapshot.files[1]?.truncated).toBe(true);
    expect(snapshot.total_bytes).toBeLessThanOrEqual(120);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
