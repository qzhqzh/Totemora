import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "./state-database";

test("legacy JSON import is idempotent and refuses silent post-cutover changes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-state-migration-"));
  const source = join(dataDir, "legacy.json");
  await writeFile(source, JSON.stringify([{ id: "one" }, { id: "two" }]));
  const state = StateDatabase.open(dataDir);
  const insert = (value: { id: string }) => state.putRecord("migration_test", value.id, value);
  expect(state.importJsonFile(source, (value) => value as Array<{ id: string }>, insert)).toEqual({
    imported: true, row_count: 2,
  });
  expect(state.importJsonFile(source, (value) => value as Array<{ id: string }>, insert)).toEqual({
    imported: false, row_count: 2,
  });
  expect(state.listRecords("migration_test")).toHaveLength(2);
  await writeFile(source, JSON.stringify([{ id: "changed" }]));
  expect(() => state.importJsonFile(source, (value) => value as Array<{ id: string }>, insert))
    .toThrow("changed after SQLite cutover");
  await rm(dataDir, { recursive: true, force: true });
});
