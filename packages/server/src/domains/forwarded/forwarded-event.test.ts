import { expect, test } from "bun:test";

import { forwardedDeliveryKey, forwardedEventId, normalizeForwardedEvent } from "./forwarded-event";

test("forwarded events preserve public ntfy semantics without carrying source credentials", () => {
  const event = normalizeForwardedEvent({
    source_id: "legacy-forwarded", source_message_id: "abc123", occurred_at: "2026-08-30T10:00:00Z",
    title: "Upstream title", body: "Body", priority: 4, tags: ["warning", "warning"],
    click_url: "https://example.com/story", image_url: "https://img.example/icon.png",
  });
  expect(event.tags).toEqual(["warning"]);
  expect(event.content_hash).toHaveLength(64);
  expect(forwardedEventId(event.source_id, event.source_message_id)).toBe(
    forwardedEventId(event.source_id, event.source_message_id),
  );
  expect(forwardedDeliveryKey(event)).toMatch(/^forwarded:relay:[a-f0-9]{40}$/);
  expect(JSON.stringify(event)).not.toContain("authorization");
});

test("forwarded events reject empty content and unsafe external metadata", () => {
  const base = {
    source_id: "legacy-forwarded", source_message_id: "abc123", occurred_at: "2026-08-30T10:00:00Z",
    title: "", body: "Body", priority: 3, tags: [],
  };
  expect(() => normalizeForwardedEvent({ ...base, body: "" })).toThrow("title or body");
  expect(() => normalizeForwardedEvent({ ...base, click_url: "http://example.com" })).toThrow("HTTPS");
  expect(() => normalizeForwardedEvent({ ...base, priority: 6 })).toThrow("1-5");
});
