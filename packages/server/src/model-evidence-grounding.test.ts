import { expect, test } from "bun:test";

import { groundEvidenceUrls, optionalEvidenceId } from "./model-evidence-grounding";

const references = [
  { id: 1, url: "https://example.com/one" },
  { id: 2, url: "https://example.com/two" },
];

test("grounds an invented model URL through its evidence id", () => {
  expect(groundEvidenceUrls([
    { evidence_id: 1, url: "https://invented.example/item", headline: "one" },
  ], references)).toEqual({
    items: [{ evidence_id: 1, url: "https://example.com/one", headline: "one" }],
    corrected: 1,
    invalid: [],
  });
});

test("accepts legacy exact URLs but rejects conflicting or unknown evidence", () => {
  const legacy = { url: "https://example.com/one", headline: "legacy" };
  const conflict = { evidence_id: 1, url: "https://example.com/two", headline: "conflict" };
  const unknown = { evidence_id: 3, url: "https://invented.example/item", headline: "unknown" };
  const unknownWithAllowedUrl = { evidence_id: 3, url: "https://example.com/one", headline: "unknown allowed" };

  expect(groundEvidenceUrls([legacy, conflict, unknown, unknownWithAllowedUrl], references)).toEqual({
    items: [legacy],
    corrected: 0,
    invalid: [conflict, unknown, unknownWithAllowedUrl],
  });
  expect(optionalEvidenceId("2")).toBe(2);
  expect(optionalEvidenceId(0)).toBeUndefined();
  expect(optionalEvidenceId("not-a-number")).toBeUndefined();
});
