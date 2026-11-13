import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotifierClient } from "./client";
import { createNotifierApp } from "./app";
import { NotifierDatabase } from "./storage";

test("standalone Notifier authenticates sources, commits before ack and alone delivers internal/external notifications", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-standalone-notifier-"));
  const sourceToken = "s".repeat(64);
  const operatorToken = "o".repeat(64);
  let sends = 0;
  const externalFetch = (async () => { sends += 1; return Response.json({ code: 200 }); }) as unknown as typeof fetch;
  try {
    const app = await createNotifierApp({
      dataDir, operatorToken, fetchImpl: externalFetch,
      targets: { telegramTargets: [], ntfyTargets: [] },
      config: {
        operator_token: operatorToken, sources: [{ id: "backup", token: sourceToken }],
        rules: [{ id: "alerts", source: "backup", type_prefix: "backup.failed", targets: ["bark:phone"], coalesce_window_seconds: 60 }],
        email: [], bark: [{ id: "phone", device_key: "secret-key", server_url: "https://bark.example.test",
          domains: ["ops", "ai"], enabled: true }],
      },
    });
    const inboxUrl = "http://notifier/api/integrations/notifications/events";
    const event = { schema_version: 1, source: "backup", id: "run-1", type: "backup.failed.disk",
      title: "Storage error", body: "The storage device is offline" };
    expect((await app.fetch(new Request(inboxUrl, { method: "POST", body: JSON.stringify(event) }))).status).toBe(401);
    const post = (value: unknown) => app.fetch(new Request(inboxUrl, { method: "POST",
      headers: { authorization: `Bearer ${sourceToken}` }, body: JSON.stringify(value) }));
    const accepted = await post(event);
    expect(accepted.status).toBe(202);
    expect((await accepted.json() as { status: string }).status).toBe("pending");
    expect(sends).toBe(0);
    expect(NotifierDatabase.open(dataDir).db.query("SELECT count(*) as count FROM external_notification_events")
      .get()).toMatchObject({ count: 1 });
    expect(await app.runDue()).toMatchObject({ claimed: 1, completed: 1 });
    expect(sends).toBe(1);
    expect(await post(event).then((response) => response.json())).toMatchObject({ duplicate: true, status: "completed" });
    expect((await post({ ...event, title: "Conflict" })).status).toBe(409);
    const missingRule = await post({ ...event, id: "run-2", type: "backup.ok" });
    expect(await missingRule.json()).toMatchObject({ status: "unrouted" });
    const client = new NotifierClient({ baseUrl: "http://127.0.0.1:4321", operatorToken,
      fetchImpl: ((url: URL | Request | string, init?: RequestInit) => app.fetch(new Request(url, init))) as typeof fetch });
    const envelope = { schema_version: 1, id: "ai-1", idempotency_key: "ai-1", domain: "ai",
      kind: "status", title: "AI update", body: "From Totemora", priority: 3, tags: [] };
    expect((await client.dispatch({ member_id: "intelligence", envelope })).status).toBe("completed");
    expect((await client.dispatch({ member_id: "intelligence", envelope })).deliveries[0]?.replayed).toBe(true);
    expect(sends).toBe(2);
    const serialized = JSON.stringify(await client.listTargets());
    expect(serialized).toContain("phone");
    expect(serialized).not.toContain("secret-key");
    expect(serialized).not.toContain(sourceToken);
    const targetList = await client.listTargets() as Array<{ destination_fingerprint?: string; server_host?: string }>;
    expect(targetList[0]?.destination_fingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(targetList[0]?.server_host).toBe("bark.example.test");
    expect((await app.fetch(new Request("http://notifier/api/v1/targets"))).status).toBe(401);
    expect((await app.fetch(new Request("http://notifier/api/v1/status"))).status).toBe(401);
    const operatorHeaders = { authorization: `Bearer ${operatorToken}` };
    const testUrl = "http://notifier/api/v1/test";
    const testMessage = { schema_version: 1, domain: "ai", channel: "bark", target_id: "phone", idempotency_key: "smoke-1" };
    const sendTest = (body: unknown, authorized = true) => app.fetch(new Request(testUrl, {
      method: "POST", headers: authorized ? operatorHeaders : {}, body: JSON.stringify(body),
    }));
    expect((await sendTest(testMessage, false)).status).toBe(401);
    expect((await sendTest({ ...testMessage, target_id: "other" })).status).toBe(409);
    expect((await sendTest({ ...testMessage, title: "arbitrary message" })).status).toBe(400);
    expect((await sendTest({ ...testMessage, domain: "finance" })).status).toBe(409);
    expect(sends).toBe(2);
    const result = await (await sendTest(testMessage)).json() as { status: string; deliveries: Array<{ replayed?: boolean }> };
    expect(result.status).toBe("completed");
    expect(sends).toBe(3);
    expect((await (await sendTest(testMessage)).json() as typeof result).deliveries[0]?.replayed).toBe(true);
    expect(sends).toBe(3);
    const journal = await app.fetch(new Request("http://notifier/api/v1/deliveries?idempotency_key=operator-test:smoke-1", {
      headers: operatorHeaders,
    }));
    expect(journal.status).toBe(200);
    expect(JSON.stringify(await journal.json())).not.toContain("secret-key");
    const events = await (await app.fetch(new Request("http://notifier/api/notifications/events", { headers: operatorHeaders })))
      .json() as { events: Array<{ event_uuid: string }> };
    const eventResponse = await app.fetch(new Request(`http://notifier/api/notifications/events/${events.events[0]!.event_uuid}`, {
      headers: operatorHeaders,
    }));
    expect(eventResponse.status).toBe(200);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
