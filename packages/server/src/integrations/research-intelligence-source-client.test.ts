import { expect, test } from "bun:test";

import { ResearchIntelligenceSourceClient } from "./research-intelligence-source-client";

const directions = [
  { id: "citrus", name: "柑橘", keywords: ["citrus", "Citrus sinensis"], enabled: true },
  { id: "banana", name: "香蕉", keywords: ["banana", "Musa acuminata"], enabled: true },
];

test("research source client normalizes arXiv preprints and Europe PMC articles", async () => {
  const requests: string[] = [];
  const client = new ResearchIntelligenceSourceClient((async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("export.arxiv.org")) return new Response(`
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/2608.12345v1</id>
          <title>  Citrus discovery &amp; reliable science  </title>
          <summary>A bounded citrus evaluation with released code.</summary>
          <published>2026-08-29T12:00:00Z</published>
          <author><name>A. Researcher</name></author>
          <category term="cs.AI" />
        </entry>
      </feed>`);
    if (url.includes("europepmc")) return Response.json({ resultList: { result: [{
      id: "12345678", source: "MED", doi: "10.1000/test.paper", title: "A banana research result",
      firstPublicationDate: "2026-08-28", journalTitle: "Journal of Tests", authorString: "B. Scientist",
      abstractText: "A controlled banana study reports a measurable effect.", citedByCount: 2,
      isPreprint: "N", pubTypeList: { publicationType: ["Journal Article"] },
    }] } });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch);

  const now = new Date("2026-08-30T12:00:00.000Z");
  expect(await client.collectArxiv(directions, now)).toEqual([expect.objectContaining({
    title: "Citrus discovery & reliable science",
    link: "https://arxiv.org/abs/2608.12345v1",
    source: "arXiv · 预印本",
    category: "research_preprint",
    published_at: "2026-08-29T12:00:00.000Z",
    research_direction_ids: ["citrus"],
    research_direction_names: ["柑橘"],
  })]);
  expect(await client.collectEuropePmc(directions, now)).toEqual([expect.objectContaining({
    title: "A banana research result",
    link: "https://doi.org/10.1000/test.paper",
    source: "Europe PMC · Journal of Tests",
    category: "research_article",
    published_at: "2026-08-28T00:00:00.000Z",
    research_direction_ids: ["banana"],
    research_direction_names: ["香蕉"],
  })]);
  expect(requests[0]).toContain("sortBy=submittedDate");
  expect(requests[0]).toContain("max_results=12");
  expect(requests[1]).toContain("resultType=core");
  expect(requests[1]).toContain("pageSize=12");
  expect(new URL(requests[0]!).searchParams.get("search_query")).toContain('all:"citrus"');
  expect(new URL(requests[1]!).searchParams.get("query")).toContain('TITLE_ABS:"banana"');
});

test("research source client rejects unusable payloads without inventing article URLs", async () => {
  const client = new ResearchIntelligenceSourceClient((async (input: string | URL | Request) => {
    if (String(input).includes("export.arxiv.org")) return new Response(`
      <feed><entry><id>https://evil.example/abs/1</id><title>Injected citrus paper</title></entry></feed>`);
    return Response.json({ resultList: { result: [{ title: "Missing banana identity", source: "MED" }] } });
  }) as typeof fetch);
  expect(await client.collectArxiv(directions)).toEqual([]);
  expect(await client.collectEuropePmc(directions)).toEqual([]);
});

test("research source client stays quiet when no direction is enabled", async () => {
  let requests = 0;
  const client = new ResearchIntelligenceSourceClient((async (_input: string | URL | Request) => {
    requests += 1;
    throw new Error("fetch should not run");
  }) as unknown as typeof fetch);
  const disabled = [{ id: "citrus", name: "柑橘", keywords: ["citrus"], enabled: false }];
  expect(await client.collectArxiv(disabled)).toEqual([]);
  expect(await client.collectEuropePmc([])).toEqual([]);
  expect(requests).toBe(0);
});
