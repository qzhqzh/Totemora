import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadLocalConfig } from "@totemora/core";
import { FinanceIntelligenceService } from "../finance-intelligence-service";
import { IntelligenceService } from "../intelligence-service";
import { MemberStateStore } from "../member-state-store";
import { StateDatabase } from "../state-database";
import { IntelligenceBriefRepository } from "./intelligence-brief-repository";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "intelligence-brief-limit-")); directories.push(directory);
  const state = StateDatabase.open(directory);
  return { directory, state, repository: new IntelligenceBriefRepository(state) };
}
const namespaces = { ai: "intelligence_briefs", finance: "finance_intelligence_briefs" } as const;

test("bounded brief reads sort by creation before update time and isolate AI from finance", async () => {
  const { state, repository } = await fixture();
  for (const [domain, namespace] of Object.entries(namespaces)) {
    for (const [id, created, updated] of [
      ["old-recently-updated", "2026-01-01", "2026-10-28"],
      ["new-first-update", "2026-10-25", "2026-10-25"],
      ["new-later-update", "2026-10-25", "2026-10-26"],
    ]) state.putRecord(namespace, `${domain}-${id}`, { id: `${domain}-${id}`, created_at: `${created}T00:00:00.000Z` },
      `${created}T00:00:00.000Z`, `${updated}T00:00:00.000Z`);
  }
  for (const domain of ["ai", "finance"] as const) {
    expect(repository.listLatest<{ id: string }>(domain, 2).map((brief) => brief.id))
      .toEqual([`${domain}-new-later-update`, `${domain}-new-first-update`]);
    expect(repository.listLatest<{ id: string }>(domain, 3).at(-1)?.id).toBe(`${domain}-old-recently-updated`);
  }
});

test("SQL limits rows before decoding and does not parse a large unselected historical payload", async () => {
  const { state, repository } = await fixture();
  state.putRecord(namespaces.ai, "latest", { id: "latest", created_at: "2026-10-25T00:00:00.000Z" },
    "2026-10-25T00:00:00.000Z", "2026-10-25T00:00:00.000Z");
  state.db.query("INSERT INTO records(namespace,id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run(namespaces.ai, "large-history", `{"unparsed":"${"x".repeat(2 * 1024 * 1024)}`,
      "2026-01-01T00:00:00.000Z", "2026-10-26T00:00:00.000Z");
  const query = spyOn(state.db, "query");
  try {
    expect(repository.listLatest<{ id: string; created_at: string }>("ai", 1))
      .toEqual([{ id: "latest", created_at: "2026-10-25T00:00:00.000Z" }]);
    const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " "));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/ORDER BY created_at DESC,\s*updated_at DESC LIMIT \?/i);
    expect(() => repository.listLatest("ai", 2)).toThrow();
  } finally { query.mockRestore(); }
});

test("bounded repository rejects invalid limits before reading records", async () => {
  const { state, repository } = await fixture();
  const query = spyOn(state.db, "query");
  try {
    for (const limit of [0, -1, 101, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER, "4", null]) {
      expect(() => repository.listLatest("ai", limit as number)).toThrow("limit");
    }
    expect(query).not.toHaveBeenCalled();
  } finally { query.mockRestore(); }
});

test("AI and finance service list without a limit retain full history while explicit limits use newest records", async () => {
  const { state, directory } = await fixture();
  const start = Date.parse("2026-10-25T00:00:00.000Z");
  for (const namespace of Object.values(namespaces)) {
    for (let index = 0; index < 105; index += 1) {
      const created = new Date(start + index * 1000).toISOString();
      state.putRecord(namespace, `brief-${index}`, { id: `brief-${index}`, created_at: created }, created,
        new Date(start + (105 - index) * 1000).toISOString());
    }
  }
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../../configs/example") });
  const members = new MemberStateStore(directory, config);
  const providers = { get() { throw new Error("listing must not invoke a model"); } };
  const services = [
    new IntelligenceService(config, providers, members, directory, resolve(import.meta.dir, "../../../..")),
    new FinanceIntelligenceService(config, providers, members, directory, resolve(import.meta.dir, "../../../..")),
  ];
  for (const service of services) {
    expect(await service.list()).toHaveLength(105);
    expect(await service.list(undefined)).toHaveLength(105);
    expect((await service.list(4)).map((brief) => brief.id)).toEqual(["brief-104", "brief-103", "brief-102", "brief-101"]);
    expect(await service.list(1)).toHaveLength(1);
    expect(await service.list(100)).toHaveLength(100);
    await expect(service.list(0)).rejects.toThrow("limit");
  }
});
