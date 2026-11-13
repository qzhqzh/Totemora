import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupFromGateway } from "./setup-from-gateway";

test("one-time setup copies private targets, translates only known container URLs and never overwrites", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "notifier-setup-"));
  const secrets = join(dataDir, "secrets");
  await mkdir(secrets, { mode: 0o700 });
  await writeFile(join(secrets, "bark-targets.json"), JSON.stringify([{ id: "phone", device_key: "key",
    server_url: "http://127.0.0.1:18080", domains: ["ai"], enabled: true }]), { mode: 0o600 });
  await writeFile(join(secrets, "notification-targets.json"), JSON.stringify({ schema_version: 1, telegram: [],
    ntfy: [{ id: "updates", server_url: "http://127.0.0.1:40011", topic: "updates",
      domains: ["ai"], enabled: true }] }), { mode: 0o600 });
  try {
    expect((await setupFromGateway(dataDir)).applied).toBe(false);
    expect((await setupFromGateway(dataDir, true)).applied).toBe(true);
    const configPath = join(secrets, "notifier", "notification-ingress.json");
    const ingress = JSON.parse(await readFile(configPath, "utf8"));
    expect(ingress.bark[0].server_url).toBe("http://bark:8080/");
    expect(ingress.bark[0].device_key).toBe("key");
    expect((await stat(configPath)).mode & 0o077).toBe(0);
    expect((await stat(join(secrets, "notifier-token"))).mode & 0o077).toBe(0);
    const targets = JSON.parse(await readFile(join(secrets, "notifier", "notification-targets.json"), "utf8"));
    expect(targets.ntfy[0].server_url).toBe("http://ntfy:80/");
    await expect(setupFromGateway(dataDir, true)).rejects.toThrow("refusing to overwrite");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
