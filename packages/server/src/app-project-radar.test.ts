import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DecisionProvider } from "@totemora/core";
import { createPlaygroundApp } from "./app";

const root = resolve(import.meta.dir, "../../..");
async function fixture(provider?: DecisionProvider) {
  const dataDir = await mkdtemp(join(tmpdir(), "radar-api-"));
  const app = createPlaygroundApp({ dataDir, configDir: resolve(root, "configs/example"), projectRoot: root,
    operatorToken: "radar-operator", projectRadarProvider: provider });
  const call = (path = "", method = "GET", body?: unknown, authenticated = true) => app.fetch(new Request(
    `http://localhost/api/intelligence/radar${path}`, {
      method, headers: authenticated ? { authorization: "Bearer radar-operator", "content-type": "application/json" } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  ));
  return { dataDir, app, call };
}

test("project cards, decisions and digest are private; initial settings cannot spend or send", async () => {
  const { dataDir, app, call } = await fixture();
  try {
    for (const [path, method, body] of [["", "GET"], ["/digest", "GET"], ["/actions", "GET"],
      ["/actions/missing/decision", "POST", {}], ["/settings", "PUT", {}], ["/evaluate", "POST", {}]] as const) {
      expect((await call(path, method, body, false)).status).toBe(401);
    }
    const response = await call();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const status = await response.json();
    expect(status).toMatchObject({ configured: false, settings: { mode: "off", timezone: "Asia/Shanghai", digest_time: "19:30" } });
    expect(status.settings.projects.map((project: { id: string }) => project.id)).toEqual(["totemora", "foundry-studio"]);
    expect(status.evaluations).toEqual([]);
    expect((await call("/evaluate", "POST", { limit: 10 })).status).toBe(409);
    expect(await app.runScheduledProjectRadar()).toBeUndefined();
    expect((await call("/settings", "PUT", { ...status.settings, mode: "shadow" })).status).toBe(200);
    expect((await call("/settings", "PUT", { ...status.settings, mode: "active" })).status).toBe(200);
    expect((await call("/digest")).status).toBe(200);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("settings validate complete input, persist edits and bound evaluation requests", async () => {
  let calls = 0;
  const { dataDir, call } = await fixture({ evaluate: async () => { calls++; throw new Error("not expected"); } });
  try {
    const { settings } = await (await call()).json();
    settings.projects[0].goal = "验证项目卡保存";
    expect((await call("/settings", "PUT", settings)).status).toBe(200);
    expect((await (await call()).json()).settings.projects[0].goal).toBe("验证项目卡保存");
    for (const input of [{ mode: "active" }, { ...settings, mode: "surprise" }, { ...settings, digest_time: "27:00" },
      { ...settings, daily_token_limit: 9_999_999 }, { ...settings, projects: [] }]) {
      expect((await call("/settings", "PUT", input)).status).toBe(400);
    }
    for (const input of [{ limit: 11 }, { limit: "10" }, { candidate_ids: ["../private"] }, { candidate_ids: ["same", "same"] }, { force_push: true }]) {
      expect((await call("/evaluate", "POST", input)).status).toBe(400);
    }
    const oversized = await call("/settings", "PUT", { ...settings, unknown: "x".repeat(33_000) });
    expect(oversized.status).toBe(413);
    expect((await call("/settings", "PUT", { ...settings, mode: "shadow" })).status).toBe(200);
    expect((await call("/evaluate", "POST", { limit: 1 })).status).toBe(200);
    expect(calls).toBe(0);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
