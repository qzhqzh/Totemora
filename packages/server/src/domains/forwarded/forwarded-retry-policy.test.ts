import { expect, test } from "bun:test";

import { classifyForwardedSourceError, forwardedPollingBackoff, forwardedRetryDelayMs } from "./forwarded-retry-policy";

test("source retry delays remain bounded and reset after a successful poll", () => {
  expect(forwardedRetryDelayMs(1)).toBe(5 * 60_000);
  expect(forwardedRetryDelayMs(2)).toBe(10 * 60_000);
  expect(forwardedRetryDelayMs(1, "certificate")).toBe(30 * 60_000);
  expect(forwardedRetryDelayMs(1, "authentication")).toBe(30 * 60_000);
  expect(forwardedRetryDelayMs(1, "configuration")).toBe(30 * 60_000);
  expect(forwardedRetryDelayMs(80_000)).toBe(6 * 60 * 60_000);
  const prior = forwardedPollingBackoff(undefined, "unavailable", "2026-08-30T10:00:00Z");
  expect(forwardedPollingBackoff(prior, "unavailable", "2026-08-30T10:05:00Z")).toMatchObject({
    consecutive_failures: 2, next_poll_at: "2026-08-30T10:15:00.000Z",
  });
  expect(forwardedPollingBackoff(undefined, "unavailable", "2026-08-30T10:05:00Z")).toMatchObject({
    consecutive_failures: 1, next_poll_at: "2026-08-30T10:10:00.000Z",
  });
});

test("source errors inspect bounded cause chains and exclude raw endpoint or response text", () => {
  const cycle = new Error("private topic data");
  cycle.cause = cycle;
  expect(classifyForwardedSourceError(cycle)).toMatchObject({ kind: "unavailable" });
  expect(classifyForwardedSourceError(cycle).message).not.toContain("private");
  expect(classifyForwardedSourceError(new Error("unknown certificate verification error"))).toMatchObject({ kind: "certificate" });
  expect(classifyForwardedSourceError(new Error("secret filename"), "configuration").message).not.toContain("secret");
});

test("TLS handshake EOF is classified separately from certificate rejection", () => {
  const eof = Object.assign(new Error("private upstream endpoint closed the connection"), { code: "UNEXPECTED_EOF_WHILE_READING" });
  expect(classifyForwardedSourceError(new TypeError("fetch failed", { cause: eof }))).toMatchObject({ kind: "tls" });
  expect(classifyForwardedSourceError(new Error("EOF occurred in violation of protocol (_ssl.c:1006)"))).toMatchObject({ kind: "tls" });
  expect(classifyForwardedSourceError(new Error("Client network socket disconnected before secure TLS connection was established")))
    .toMatchObject({ kind: "tls" });
  expect(classifyForwardedSourceError(eof).message).not.toContain("private");
  expect(forwardedRetryDelayMs(1, "tls")).toBe(5 * 60_000);
});
