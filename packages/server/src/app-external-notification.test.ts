import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createNotifierApp } from "../../notifier/src/app";
import { NotifierDatabase } from "../../notifier/src/storage";
import { createPlaygroundApp } from "./app";

test("Gateway forwards source events and operator reads to an independent Notifier database", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-app-ingress-"));
  try {
    const notifierDataDir = join(dataDir, "notifier");
    const notifier = await createNotifierApp({
      dataDir: notifierDataDir, operatorToken: "b".repeat(64), targets: { telegramTargets: [], ntfyTargets: [] },
      config: {
        operator_token: "b".repeat(64),
        sources: [{ id: "service-one", token: "a".repeat(64) }], rules: [],
        email: [{ id: "owner", address: "private@example.test", enabled: true }],
        smtp: { host: "smtp.example.test", port: 587, secure: false,
          user: "smtp-user", password: "smtp-private", from: "sender@example.test" },
      },
    });
    const app = createPlaygroundApp({
      configDir: resolve(import.meta.dir, "../../../configs/example"), dataDir: join(dataDir, "gateway"),
      operatorToken: "operator-only", notifier: { baseUrl: "http://127.0.0.1:4321", operatorToken: "b".repeat(64) },
      fetchImpl: ((url: URL | Request | string, init?: RequestInit) => notifier.fetch(new Request(url, init))) as typeof fetch,
    });
    const payload = { schema_version: 1, source: "service-one", id: "first", type: "backup.failed",
      title: "Failure", body: "Job did not complete" };
    const url = "http://local/api/integrations/notifications/events";
    expect((await app.fetch(new Request(url, { method: "POST", body: JSON.stringify(payload) }))).status).toBe(401);
    const accepted = await app.fetch(new Request(url, {
      method: "POST", headers: { authorization: `Bearer ${"a".repeat(64)}` }, body: JSON.stringify(payload),
    }));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ source: "service-one", status: "unrouted", duplicate: false });
    const events = await app.fetch(new Request("http://local/api/notifications/events", {
      headers: { authorization: "Bearer operator-only" },
    }));
    expect(events.status).toBe(200);
    expect((await events.json() as { events: unknown[] }).events).toHaveLength(1);
    const platform = await app.fetch(new Request("http://local/api/notifications/platform", {
      headers: { authorization: "Bearer operator-only" },
    }));
    const publicTargets = await platform.text();
    expect(publicTargets).toContain('"channel":"email"');
    expect(publicTargets).not.toContain("private@example.test");
    expect(publicTargets).not.toContain("smtp-private");
    expect(NotifierDatabase.open(notifierDataDir).db.query("SELECT count(*) as count FROM external_notification_events")
      .get()).toMatchObject({ count: 1 });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
