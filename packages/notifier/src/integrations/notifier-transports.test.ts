import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNotifierApp } from "../app";
import { NotifierClient } from "../client";
import { NotifierDatabase } from "../storage";

for (const channel of ["bark", "telegram"] as const) {
  test.each([408, 500, 502, 504, 400, 429])(`${channel} persists HTTP %i delivery outcomes across restart`, async (status) => {
    const dataDir = await mkdtemp(join(tmpdir(), "totemora-transport-outcome-"));
    const operatorToken = "o".repeat(64);
    let sends = 0;
    const createApp = () => createNotifierApp({
      dataDir, operatorToken,
      fetchImpl: (async () => {
        sends += 1;
        return new Response("upstream error", { status });
      }) as unknown as typeof fetch,
      config: {
        operator_token: operatorToken, sources: [], rules: [], email: [],
        ...(channel === "bark" ? { bark: [{ id: "phone", device_key: "test-device",
          server_url: "https://bark.example.test", domains: ["ai" as const], enabled: true }] }
          : { telegram_bot_token: "12345:test_bot_token" }),
      },
      targets: { ntfyTargets: [], telegramTargets: channel === "telegram"
        ? [{ id: "chat", chat_id: "-12345", domains: ["ai"], enabled: true }] : [] },
    });
    const envelope = { schema_version: 1, id: "same-event", idempotency_key: "same-event", domain: "ai",
      kind: "status", title: "Update", body: "Same notification", priority: 3, tags: [] };
    const expected = status === 408 || status >= 500 ? "uncertain" : "failed";
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const app = await createApp();
        const client = new NotifierClient({ baseUrl: "http://127.0.0.1:4321", operatorToken,
          fetchImpl: ((url: URL | Request | string, init?: RequestInit) => app.fetch(new Request(url, init))) as typeof fetch });
        expect((await client.dispatch({ member_id: "intelligence", envelope })).status).toBe(expected);
      }
      const attempts = expected === "uncertain" ? 1 : 2;
      expect(sends).toBe(attempts);
      expect(NotifierDatabase.open(dataDir).db.query("SELECT status,attempts FROM action_journal").all())
        .toEqual([{ status: expected, attempts }]);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
}
