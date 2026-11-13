import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNotificationIngressConfig, parseNotificationIngressConfig } from "./notification-ingress-config";

const configured = {
  schema_version: 1,
  sources: [{ id: "backup", token: "a".repeat(64) }],
  rules: [{ id: "backup-errors", source: "backup", type_prefix: "backup.failed", targets: ["email:owner"], coalesce_window_seconds: 300 }],
  email: [{ id: "owner", address: "owner@example.test" }],
  smtp: { host: "smtp.example.test", port: 587, secure: false, user: "smtp-user", password: "smtp-secret", from: "sender@example.test" },
};

test("ingress config is disabled by default and only reads an owner-only regular file", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-ingress-config-"));
  try {
    expect(await loadNotificationIngressConfig({ dataDir })).toEqual({ sources: [], rules: [], email: [] });
    const secretsDir = join(dataDir, "secrets");
    await mkdir(secretsDir);
    const filePath = join(secretsDir, "notification-ingress.json");
    await writeFile(filePath, JSON.stringify(configured), { mode: 0o600 });
    expect(await loadNotificationIngressConfig({ dataDir })).toMatchObject({
      sources: [{ id: "backup" }], rules: [{ id: "backup-errors" }], email: [{ enabled: true }],
    });
    await chmod(filePath, 0o644);
    await expect(loadNotificationIngressConfig({ dataDir })).rejects.toThrow("private regular file");
    const link = join(dataDir, "link.json");
    await symlink(filePath, link);
    await expect(loadNotificationIngressConfig({ dataDir, filePath: link })).rejects.toThrow("symbolic link");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("config rejects unknown sources/targets, ambiguous rules and missing SMTP", () => {
  expect(() => parseNotificationIngressConfig({ ...configured, operator_token: "a".repeat(64) }))
    .toThrow("must differ from every source token");
  expect(() => parseNotificationIngressConfig({ ...configured, bark: [{ id: "phone", device_key: "secret",
    server_url: "http://attacker.example", domains: ["ops"] }] })).toThrow("HTTPS or a local service");
  expect(() => parseNotificationIngressConfig({ ...configured, smtp: undefined })).toThrow("SMTP must be configured");
  expect(() => parseNotificationIngressConfig({ ...configured, rules: [
    { ...configured.rules[0], source: "another" },
  ] })).toThrow("source is not configured");
  expect(() => parseNotificationIngressConfig({ ...configured, rules: [
    { ...configured.rules[0], targets: ["email:unknown"] },
  ] })).toThrow("unknown email target");
  expect(() => parseNotificationIngressConfig({ ...configured, sources: [
    ...configured.sources, ...configured.sources,
  ] })).toThrow("must be unique");
  expect(() => parseNotificationIngressConfig({ ...configured, sources: [
    ...configured.sources, { id: "another", token: "a".repeat(64) },
  ] })).toThrow("must be unique");
  expect(() => parseNotificationIngressConfig({ ...configured, sources: [
    { id: "backup", token: `${"a".repeat(32)} ${"b".repeat(32)}` },
  ] })).toThrow("non-whitespace");
  expect(() => parseNotificationIngressConfig({ ...configured, smtp: {
    ...configured.smtp, from: "owner@example.test\nBcc: attacker@example.test",
  } })).toThrow("safe characters");
});
