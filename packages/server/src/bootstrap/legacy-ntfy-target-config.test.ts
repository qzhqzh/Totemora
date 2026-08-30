import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureLegacyNtfyTargets } from "./legacy-ntfy-target-config";
import { loadNotificationRuntimeTargets } from "./notification-runtime-config";

test("writes six private legacy ntfy routes without exposing credentials in its report", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-ntfy-targets-"));
  const credentialsFile = join(root, "worker-auth.md");
  const outputFile = join(root, "secrets", "notification-targets.json");
  try {
    await writeFile(credentialsFile, "worker\nprivate-password\n", { mode: 0o600 });
    await chmod(credentialsFile, 0o600);
    const report = await configureLegacyNtfyTargets({ credentialsFile, outputFile });
    expect(report).toMatchObject({ telegram_targets_preserved: 0, custom_ntfy_targets_preserved: 0 });
    expect(report.legacy_targets).toHaveLength(6);
    expect(report.legacy_targets.slice(0, 3)).toEqual([
      { id: "legacy-ntfy-ai", domain: "ai", topic: "hotspot" },
      { id: "legacy-ntfy-finance", domain: "finance", topic: "finance" },
      { id: "legacy-ntfy-reminder", domain: "reminder", topic: "memo" },
    ]);
    expect(JSON.stringify(report)).not.toContain("private-password");
    expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
    const loaded = await loadNotificationRuntimeTargets({ dataDir: root, filePath: outputFile });
    expect(loaded.ntfyTargets).toHaveLength(6);
    expect(loaded.ntfyTargets[0]?.authorization).toMatch(/^Basic /);
    const before = await readFile(outputFile, "utf8");
    await expect(configureLegacyNtfyTargets({
      credentialsFile, outputFile, serverUrl: "http://notify.example.test",
    })).rejects.toThrow("HTTPS or loopback HTTP");
    expect(await readFile(outputFile, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves existing Telegram and custom ntfy targets during a credential rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-ntfy-target-merge-"));
  const credentialsFile = join(root, "worker-auth.md");
  const outputFile = join(root, "secrets", "notification-targets.json");
  try {
    await writeFile(credentialsFile, "worker\nprivate-password\n", { mode: 0o600 });
    await mkdir(join(root, "secrets"));
    await writeFile(outputFile, JSON.stringify({
      schema_version: 1,
      telegram: [{ id: "daily", chat_id: "-100123", domains: ["ai"], enabled: true }],
      ntfy: [{
        id: "custom", server_url: "https://notify.example.test", topic: "custom",
        domains: ["ops"], enabled: true,
      }],
    }), { mode: 0o600 });
    const report = await configureLegacyNtfyTargets({ credentialsFile, outputFile });
    expect(report).toMatchObject({ telegram_targets_preserved: 1, custom_ntfy_targets_preserved: 1 });
    const raw = JSON.parse(await readFile(outputFile, "utf8")) as { telegram: unknown[]; ntfy: unknown[] };
    expect(raw.telegram).toHaveLength(1);
    expect(raw.ntfy).toHaveLength(7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
