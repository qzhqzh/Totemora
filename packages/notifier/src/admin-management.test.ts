import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNotifierApp } from "./app";

const origin = "http://notifier";
const operator = "o".repeat(64);
const sourceToken = "s".repeat(64);
const initialKey = "initial-phone-key-1234";
const config = {
  operator_token: operator,
  sources: [{ id: "backup", token: sourceToken }],
  rules: [{ id: "failed", source: "backup", type_prefix: "backup.failed",
    targets: ["bark:phone"], coalesce_window_seconds: 0 }],
  bark: [{ id: "phone", label: "旧手机", device_key: initialKey,
    server_url: "https://bark.example.test/", domains: ["ai", "ops"] as Array<"ai" | "ops">, enabled: true }],
  email: [],
};

test("admin login is same-origin, cookie-only, private and keeps bearer API isolated", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "notifier-admin-session-"));
  try {
    const app = await createNotifierApp({ dataDir, config, operatorToken: operator,
      targets: { telegramTargets: [], ntfyTargets: [] } });
    const page = await app.fetch(new Request(`${origin}/admin/`));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).not.toContain(operator);
    expect((await app.fetch(new Request(`${origin}/admin/styles.css`))).status).toBe(200);
    expect((await app.fetch(new Request(`${origin}/admin/favicon.svg`))).status).toBe(200);
    expect((await app.fetch(new Request(`${origin}/admin/private.json`))).status).toBe(404);
    expect((await app.fetch(new Request(`${origin}/admin/api/config`))).status).toBe(401);
    expect((await app.fetch(new Request(`${origin}/admin/api/login`, { method: "POST",
      body: JSON.stringify({ token: operator }) }))).status).toBe(403);
    expect((await app.fetch(new Request(`${origin}/admin/api/login`, { method: "POST",
      headers: { origin }, body: JSON.stringify({ token: "wrong" }) }))).status).toBe(401);
    const login = await app.fetch(new Request(`${origin}/admin/api/login`, { method: "POST",
      headers: { origin }, body: JSON.stringify({ token: operator }) }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const admin = await app.fetch(new Request(`${origin}/admin/api/config`, { headers: { cookie: cookie! } }));
    expect(admin.status).toBe(200);
    const body = await admin.text();
    expect(body).toContain('"device_key_suffix":"1234"');
    for (const secret of [operator, sourceToken, initialKey]) expect(body).not.toContain(secret);
    expect((await app.fetch(new Request(`${origin}/api/v1/targets`, { headers: { cookie: cookie! } }))).status).toBe(401);
    expect((await app.fetch(new Request(`${origin}/admin/api/rules`, { method: "PUT",
      headers: { cookie: cookie!, origin: "https://attacker.example" }, body: JSON.stringify({ revision: "x", rules: [] }) }))).status).toBe(403);
    expect((await app.fetch(new Request(`${origin}/admin/api/bark`, { method: "POST",
      headers: { cookie: cookie!, origin }, body: "x".repeat(5_100) }))).status).toBe(413);
    expect((await app.fetch(new Request(`${origin}/admin/api/config`, {
      headers: { cookie: cookie!, authorization: `Bearer ${sourceToken}` },
    }))).status).toBe(200);
    const logout = await app.fetch(new Request(`${origin}/admin/api/logout`, { method: "POST",
      headers: { cookie: cookie!, origin } }));
    expect(logout.status).toBe(200);
    expect((await app.fetch(new Request(`${origin}/admin/api/config`, { headers: { cookie: cookie! } }))).status).toBe(401);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("Bark edit activates without restart, persists privately, preserves immutable inputs, and rejects stale updates", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "notifier-admin-update-"));
  const sends: Array<{ device_key: string }> = [];
  const mockFetch = (async (_url: unknown, options?: RequestInit) => {
    sends.push(JSON.parse(String(options?.body)) as { device_key: string });
    return Response.json({ code: 200 });
  }) as typeof fetch;
  try {
    const create = () => createNotifierApp({ dataDir, config, operatorToken: operator,
      targets: { telegramTargets: [], ntfyTargets: [] }, fetchImpl: mockFetch });
    const app = await create();
    const cookie = await login(app);
    const before = await getConfig(app, cookie);
    const payload = { revision: before.revision, label: "新手机", device_key: "new-phone-key-Mn2d",
      server_url: "https://bark.example.test/", domains: ["ai", "ops"], enabled: true };
    const changed = await admin(app, cookie, "PUT", "/bark/phone", payload);
    expect(changed.status).toBe(200);
    const state = await changed.json() as { revision: string; targets: Array<{ device_key_suffix: string }> };
    expect(state.targets[0]?.device_key_suffix).toBe("Mn2d");
    expect(state.revision).not.toBe(before.revision);
    expect(sends).toHaveLength(0);
    expect((await admin(app, cookie, "PUT", "/bark/phone", payload)).status).toBe(409);
    expect((await admin(app, cookie, "PUT", "/bark/phone", { ...payload, revision: state.revision,
      server_url: "http://example.com" })).status).toBe(400);
    expect((await admin(app, cookie, "PUT", "/bark/phone", { ...payload, revision: state.revision,
      domains: ["ai"] })).status).toBe(409);
    const result = await admin(app, cookie, "POST", "/test", { schema_version: 1, channel: "bark",
      target_id: "phone", domain: "ai", idempotency_key: "admin-regression-1" });
    expect((await result.json() as { status: string }).status).toBe("completed");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ device_key: "new-phone-key-Mn2d" });
    expect((await admin(app, cookie, "POST", "/test", { schema_version: 1, channel: "bark",
      target_id: "phone", domain: "ai", idempotency_key: "admin-regression-1" })).status).toBe(200);
    expect(sends).toHaveLength(1);
    const persisted = join(dataDir, "secrets/notification-admin.json");
    expect((await stat(persisted)).mode & 0o077).toBe(0);
    expect(await readFile(persisted, "utf8")).toContain("new-phone-key-Mn2d");
    const restarted = await create();
    const cookieAfterRestart = await login(restarted);
    expect((await getConfig(restarted, cookieAfterRestart)).targets[0]?.device_key_suffix).toBe("Mn2d");
    const bearer = await restarted.fetch(new Request(`${origin}/api/v1/targets`, {
      headers: { authorization: `Bearer ${operator}` },
    }));
    expect(await bearer.text()).not.toContain("new-phone-key-Mn2d");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("SMTP, sources and ordered rules persist without leaking credentials or erasing existing rules", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "notifier-admin-rules-"));
  try {
    const create = () => createNotifierApp({ dataDir, config, operatorToken: operator,
      targets: { telegramTargets: [], ntfyTargets: [] } });
    const app = await create();
    const cookie = await login(app);
    let rev = (await getConfig(app, cookie)).revision;
    const newSource = await admin(app, cookie, "POST", "/sources", { revision: rev, id: "other-system" });
    expect(newSource.status).toBe(201);
    const sourceBody = await newSource.json() as { revision: string; source_token: string };
    expect(sourceBody.source_token).toMatch(/^[a-f0-9]{64}$/);
    rev = sourceBody.revision;
    const email = await admin(app, cookie, "PUT", "/email", { revision: rev,
      smtp: { host: "smtp.example.test", port: 587, secure: false, user: "sender", password: "private-password",
        from: "sender@example.test" }, target: { id: "owner", address: "owner@example.test", enabled: true } });
    expect(email.status).toBe(200);
    const emailBody = await email.text();
    expect(emailBody).not.toContain("private-password");
    expect(emailBody).not.toContain("owner@example.test");
    rev = (JSON.parse(emailBody) as { revision: string }).revision;
    const rules = [config.rules[0], { id: "other", source: "other-system", type_prefix: "system.failed",
      targets: ["email:owner"], coalesce_window_seconds: 60 }];
    expect((await admin(app, cookie, "PUT", "/rules", { revision: rev, rules })).status).toBe(200);
    const state = await getConfig(app, cookie);
    expect(state.rules.map((rule) => rule.id)).toEqual(["failed", "other"]);
    expect((await admin(app, cookie, "PUT", "/email", { revision: state.revision,
      target: { id: "owner", enabled: false } })).status).toBe(409);
    const aiOnly = await admin(app, cookie, "POST", "/bark", { revision: state.revision,
      id: "ai-only", label: "AI 手机", device_key: "ai-only-secret", server_url: "https://bark.example.test/",
      domains: ["ai"], enabled: true });
    expect(aiOnly.status).toBe(201);
    const aiOnlyRevision = (await aiOnly.json() as { revision: string }).revision;
    expect((await admin(app, cookie, "PUT", "/rules", { revision: aiOnlyRevision,
      rules: [...rules, { id: "invalid-ops", source: "backup", type_prefix: "backup.new",
        targets: ["bark:ai-only"], coalesce_window_seconds: 0 }] })).status).toBe(400);
    expect((await admin(app, cookie, "DELETE", "/sources/other-system", { revision: aiOnlyRevision })).status).toBe(409);
    const restarted = await create();
    const next = await getConfig(restarted, await login(restarted));
    expect(next.sources.map((source) => source.id)).toContain("other-system");
    expect(next.targets.some((target) => target.channel === "email" && target.id === "owner")).toBe(true);
    expect(JSON.stringify(next)).not.toContain(sourceBody.source_token);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("concurrent target edits require one revision and an admin config symlink is refused", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "notifier-admin-race-"));
  try {
    const create = () => createNotifierApp({ dataDir, config, operatorToken: operator,
      targets: { telegramTargets: [], ntfyTargets: [] } });
    const app = await create();
    const cookie = await login(app);
    const revision = (await getConfig(app, cookie)).revision;
    const payload = { revision, label: "值班手机", server_url: "https://bark.example.test/",
      domains: ["ai", "ops"], enabled: true };
    const results = await Promise.all([
      admin(app, cookie, "PUT", "/bark/phone", payload),
      admin(app, cookie, "PUT", "/bark/phone", { ...payload, label: "其他手机" }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const labels = (await getConfig(app, cookie)).targets;
    expect(labels).toHaveLength(1);
    expect(await readFile(join(dataDir, "secrets/notification-admin.json"), "utf8")).not.toContain(operator);
  } finally { await rm(dataDir, { recursive: true, force: true }); }

  const unsafeDir = await mkdtemp(join(tmpdir(), "notifier-admin-symlink-"));
  try {
    await mkdir(join(unsafeDir, "secrets"), { mode: 0o700 });
    await writeFile(join(unsafeDir, "unrelated.json"), "not an admin config");
    await symlink(join(unsafeDir, "unrelated.json"), join(unsafeDir, "secrets/notification-admin.json"));
    await expect(createNotifierApp({ dataDir: unsafeDir, config, operatorToken: operator,
      targets: { telegramTargets: [], ntfyTargets: [] } })).rejects.toThrow("Cannot safely read Notifier admin config");
  } finally { await rm(unsafeDir, { recursive: true, force: true }); }
});

type App = Awaited<ReturnType<typeof createNotifierApp>>;
type PublicConfig = { revision: string; rules: Array<{ id: string }>; sources: Array<{ id: string }>;
  targets: Array<{ id: string; channel: string; device_key_suffix?: string }> };

async function login(app: App): Promise<string> {
  const response = await app.fetch(new Request(`${origin}/admin/api/login`, { method: "POST",
    headers: { origin }, body: JSON.stringify({ token: operator }) }));
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

function admin(app: App, cookie: string, method: string, path: string, body: unknown): Promise<Response> {
  return app.fetch(new Request(`${origin}/admin/api${path}`, { method,
    headers: { cookie, origin }, body: JSON.stringify(body) }));
}

async function getConfig(app: App, cookie: string): Promise<PublicConfig> {
  const response = await app.fetch(new Request(`${origin}/admin/api/config`, { headers: { cookie } }));
  expect(response.status).toBe(200);
  return response.json() as Promise<PublicConfig>;
}
