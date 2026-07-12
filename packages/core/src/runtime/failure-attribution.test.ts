import { expect, test } from "bun:test";
import { attributeFailure } from "./failure-attribution";

test("attributes provider, budget, validation and workspace failures", () => {
  expect(attributeFailure(new Error("Provider deepseek request failed (502)"))).toMatchObject({ category: "provider", retryable: true });
  expect(attributeFailure(new Error("Provider deepseek returned no text content (stop_reason=max_tokens)"))).toMatchObject({ category: "budget", retryable: true });
  expect(attributeFailure(new Error("Failed to parse staffing plan JSON"))).toMatchObject({ category: "staffing", owner: "chief" });
  expect(attributeFailure(new Error("Generic task requires a non-empty workspace snapshot"))).toMatchObject({ category: "workspace", retryable: false });
});
