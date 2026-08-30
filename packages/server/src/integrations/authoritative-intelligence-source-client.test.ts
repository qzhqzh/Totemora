import { expect, test } from "bun:test";

import { AuthoritativeIntelligenceSourceClient } from "./authoritative-intelligence-source-client";

test("authoritative intelligence client keeps only recent CISA KEV entries", async () => {
  const client = new AuthoritativeIntelligenceSourceClient((async () => Response.json({ vulnerabilities: [
    {
      cveID: "CVE-2026-12345", vendorProject: "Example", product: "Gateway",
      vulnerabilityName: "Remote execution", dateAdded: "2026-08-29",
      shortDescription: "Observed exploitation.", requiredAction: "Apply mitigations.",
      dueDate: "2026-09-01", knownRansomwareCampaignUse: "Known",
    },
    { cveID: "CVE-2026-10000", dateAdded: "2026-07-01" },
  ] })) as unknown as typeof fetch);
  expect(await client.collectCisa(new Date("2026-08-30T12:00:00Z"))).toEqual([expect.objectContaining({
    title: expect.stringContaining("CVE-2026-12345"),
    link: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=CVE-2026-12345",
    source: "cisa.gov", category: "cybersecurity", published_at: "2026-08-29T00:00:00.000Z",
  })]);
});

test("authoritative intelligence client parses bounded public USGS features", async () => {
  const client = new AuthoritativeIntelligenceSourceClient((async () => Response.json({ features: [{
    id: "quake-1",
    properties: {
      mag: 6.4, place: "Example coast", time: 1788000000000,
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/quake-1",
      sig: 700, alert: "orange", tsunami: 1,
    },
  }, {
    id: "untrusted", properties: { url: "https://attacker.example/quake", place: "bad" },
  }] })) as unknown as typeof fetch);
  const items = await client.collectUsgs();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    title: "M6.4 地震｜Example coast", source: "earthquake.usgs.gov", category: "critical_event",
  });
  expect(items[0]?.summary).toContain("海啸标记：是");
});
