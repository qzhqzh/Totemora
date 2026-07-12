import { expect, test } from "bun:test";

import { applyDiscount } from "./pricing";

test("applies a normal percentage discount", () => {
  expect(applyDiscount(100, 20)).toBe(80);
});

test("supports the no-discount boundary", () => {
  expect(applyDiscount(100, 0)).toBe(100);
});
