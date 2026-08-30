import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NotificationRuntimeConfigError,
  loadNotificationRuntimeTargets,
} from "./notification-runtime-config";

test("notification runtime defaults to no Telegram or ntfy targets", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-notification-runtime-empty-"));
  expect(await loadNotificationRuntimeTargets({ dataDir })).toEqual({
    telegramTargets: [],
    ntfyTargets: [],
  });
  await rm(dataDir, { recursive: true, force: true });
});

test("notification runtime reads versioned targets only from a private regular file", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-notification-runtime-"));
  const secretsDir = join(dataDir, "secrets");
  const filePath = join(secretsDir, "notification-targets.json");
  await mkdir(secretsDir, { recursive: true });
  await writeFile(filePath, JSON.stringify({
    schema_version: 1,
    telegram: [{ id: "daily-news", chat_id: "-1001234567890", domains: ["ai", "deals"] }],
    ntfy: [{
      id: "legacy-hotspot", server_url: "https://ntfy.example.test", topic: "hotspot",
      authorization: "Bearer runtime-secret", domains: ["ai"], enabled: false,
    }],
  }), { mode: 0o600 });

  expect(await loadNotificationRuntimeTargets({ dataDir })).toEqual({
    telegramTargets: [{
      id: "daily-news", chat_id: "-1001234567890", domains: ["ai", "deals"], enabled: true,
    }],
    ntfyTargets: [{
      id: "legacy-hotspot", server_url: "https://ntfy.example.test", topic: "hotspot",
      authorization: "Bearer runtime-secret", domains: ["ai"], enabled: false,
    }],
  });
  await rm(dataDir, { recursive: true, force: true });
});

test("notification runtime rejects broad permissions, symlinks, and invalid domains", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-notification-runtime-invalid-"));
  const secretsDir = join(dataDir, "secrets");
  const filePath = join(secretsDir, "notification-targets.json");
  await mkdir(secretsDir, { recursive: true });
  await writeFile(filePath, JSON.stringify({ schema_version: 1, telegram: [], ntfy: [] }), { mode: 0o600 });
  await chmod(filePath, 0o644);
  await expect(loadNotificationRuntimeTargets({ dataDir })).rejects.toBeInstanceOf(NotificationRuntimeConfigError);

  await writeFile(filePath, JSON.stringify({
    schema_version: 1,
    telegram: [{ id: "bad", chat_id: "-1001", domains: ["sports"] }],
  }), { mode: 0o600 });
  await chmod(filePath, 0o600);
  await expect(loadNotificationRuntimeTargets({ dataDir })).rejects.toThrow("unsupported domain");

  const linkedPath = join(dataDir, "linked-targets.json");
  await symlink(filePath, linkedPath);
  await expect(loadNotificationRuntimeTargets({ dataDir, filePath: linkedPath })).rejects.toThrow("symbolic link");
  await rm(dataDir, { recursive: true, force: true });
});
