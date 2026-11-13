import { expect, test } from "bun:test";
import { intelligenceBriefLimit } from "./intelligence-brief-query";

test("brief limits are opt-in and accept only integers within 1–100", () => {
  expect(intelligenceBriefLimit(new URL("https://example.com/api/intelligence"))).toBeUndefined();
  for (const limit of [1, 4, 100]) expect(intelligenceBriefLimit(new URL(`https://example.com/api/intelligence?limit=${limit}`))).toBe(limit);
  for (const limit of ["", "0", "-1", "101", "1.5", "1e2", "0x10", "NaN", "Infinity", " 4", "4 ", "+4", "9007199254740993"]) {
    expect(() => intelligenceBriefLimit(new URL(`https://example.com/api/intelligence?limit=${encodeURIComponent(limit)}`)))
      .toThrow(expect.objectContaining({ status: 400 }));
  }
});

test("duplicate brief limit parameters are rejected even when their values agree", () => {
  for (const query of ["limit=4&limit=4", "limit=4&limit=5", "limit=&limit=4", "limit=4&%6cimit=5"]) {
    expect(() => intelligenceBriefLimit(new URL(`https://example.com/api/finance?${query}`)))
      .toThrow(expect.objectContaining({ status: 400 }));
  }
});
