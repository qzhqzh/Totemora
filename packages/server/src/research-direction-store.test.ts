import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResearchDirectionStore } from "./research-direction-store";

test("research directions persist a variable-sized, direction-specific query contract", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-research-directions-"));
  const store = new ResearchDirectionStore(dataDir);
  expect(await store.get()).toMatchObject({ directions: [] });
  const saved = await store.save({ directions: [
    { id: "citrus", name: "柑橘", keywords: ["citrus", "Citrus sinensis"], enabled: true },
    { id: "banana", name: "香蕉", keywords: ["banana", "Musa acuminata"], enabled: false },
  ] });
  expect(saved.directions).toEqual([
    { id: "citrus", name: "柑橘", keywords: ["citrus", "Citrus sinensis"], enabled: true },
    { id: "banana", name: "香蕉", keywords: ["banana", "Musa acuminata"], enabled: false },
  ]);
  expect((await new ResearchDirectionStore(dataDir).get()).directions).toEqual(saved.directions);
  await rm(dataDir, { recursive: true, force: true });
});

test("research directions reject duplicate ids and unbounded keywords", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-research-directions-invalid-"));
  const store = new ResearchDirectionStore(dataDir);
  await expect(store.save({ directions: [
    { id: "citrus", name: "柑橘", keywords: ["citrus"] },
    { id: "citrus", name: "甜橙", keywords: ["orange"] },
  ] })).rejects.toThrow("duplicated");
  await expect(store.save({ directions: [{
    id: "banana", name: "香蕉", keywords: Array.from({ length: 9 }, (_, index) => `banana-${index}`),
  }] })).rejects.toThrow("1-8 keywords");
  await expect(store.save({ directions: [{
    id: "banana", name: "香蕉", keywords: ["banana"], enabled: "yes",
  }] })).rejects.toThrow("enabled must be a boolean");
  await rm(dataDir, { recursive: true, force: true });
});
