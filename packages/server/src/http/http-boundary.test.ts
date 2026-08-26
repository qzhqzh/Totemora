import { expect, test } from "bun:test";

import { readJson, readOptionalJson } from "./http-boundary";

test("JSON boundary rejects malformed and missing request bodies", async () => {
  await expect(readJson(new Request("http://local", { method: "POST", body: "{" })))
    .rejects.toMatchObject({ status: 400 });
  await expect(readJson(new Request("http://local", { method: "POST" })))
    .rejects.toMatchObject({ status: 400 });
  expect(await readOptionalJson(new Request("http://local", { method: "POST" }))).toEqual({});
});

test("JSON boundary stops streaming once the byte limit is exceeded", async () => {
  const request = new Request("http://local", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(2_000) }),
  });
  await expect(readJson(request, 1_000)).rejects.toMatchObject({ status: 413 });
});

test("JSON boundary returns parsed values within the limit", async () => {
  const request = new Request("http://local", {
    method: "POST",
    body: JSON.stringify({ value: "safe" }),
  });
  expect(await readJson(request, 1_000)).toEqual({ value: "safe" });
});
