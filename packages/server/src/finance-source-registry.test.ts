import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FinanceSourceRegistry } from "./finance-source-registry";
import type { FinancePreferences } from "./finance-preference-store";

const preferences: FinancePreferences = {
  interests: ["监管"], watchlist: [], markets: ["CN"],
  channels: { disclosures: true, regulation: true, macro: true, global_official: false },
  scan_interval_minutes: 10, push_interval_seconds: 60, push_threshold: 0.78,
  novelty_history_hours: 168, updated_at: new Date(0).toISOString(),
};

test("finance sources preserve official announcement ids, symbols and evidence tiers", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-sources-"));
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("cninfo.com.cn")) return new Response(`<a href="/new/disclosure/detail?stockCode=688209&announcementId=1225470190&announcementTime=2026-08-13">英集芯关于回购事项的公告</a>`);
    if (url.includes("csrc.gov.cn")) return new Response(`<a href="/csrc/c100028/c7649078/content.shtml">中国证监会发布资本市场监管新规</a>`);
    if (url.includes("pbc.gov.cn")) return new Response(`<a href="/goutongjiaoliu/113456/113469/123/index.html">中国人民银行发布货币政策公告</a>`);
    if (url.includes("stats.gov.cn")) return new Response(`<a href="./zxfb/202608/t20260809_1965008.html" title="2026年7月份居民消费价格同比上涨0.5%">CPI</a>`);
    throw new Error(`Unexpected URL ${url}`);
  };
  const registry = new FinanceSourceRegistry(dataDir, fakeFetch as typeof fetch);
  const result = await registry.collect(preferences);
  expect(result.items.find((item) => item.source_id === "1225470190")).toMatchObject({
    market: "CN", symbols: ["688209"], evidence_tier: "S0", event_type: "ownership_change",
  });
  expect(result.items.some((item) => item.event_type === "monetary_policy")).toBe(true);
  expect(registry.status().filter((source) => source.availability === "active" && source.markets.includes("CN"))
    .every((source) => source.status === "ready")).toBe(true);
  await rm(dataDir, { recursive: true, force: true });
});

test("finance source registry degrades to recent cache without hiding the failed health state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-cache-"));
  let failing = false;
  const fakeFetch = async (input: string | URL | Request) => {
    if (failing) throw new Error("network unavailable");
    const url = String(input);
    if (url.includes("cninfo.com.cn")) return new Response(`<a href="/new/disclosure/detail?stockCode=600519&announcementId=1&announcementTime=2026-08-13">贵州茅台年度业绩公告</a>`);
    if (url.includes("csrc.gov.cn")) return new Response(`<a href="/csrc/c100028/c1/content.shtml">证监会发布监管措施</a>`);
    if (url.includes("pbc.gov.cn")) return new Response(`<a href="/goutongjiaoliu/113456/113469/1/index.html">人民银行货币政策公告</a>`);
    return new Response(`<a href="./zxfb/202608/t20260809_1.html" title="2026年7月份CPI发布">CPI发布</a>`);
  };
  const registry = new FinanceSourceRegistry(dataDir, fakeFetch as typeof fetch);
  await registry.collect(preferences);
  failing = true;
  const cached = await registry.collect(preferences);
  expect(cached.items.every((item) => item.cached)).toBe(true);
  expect(cached.warnings).toHaveLength(4);
  expect(registry.status().filter((source) => source.availability === "active" && source.markets.includes("CN"))
    .every((source) => source.status === "degraded")).toBe(true);
  await rm(dataDir, { recursive: true, force: true });
});

test("finance sources reject off-origin feed links and redirects while retaining valid official entries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-origin-"));
  const usPreferences: FinancePreferences = {
    ...preferences, markets: ["US"], channels: { disclosures: true, regulation: false, macro: false, global_official: true },
  };
  const requested: string[] = [];
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("federalreserve.gov")) {
      return new Response("", { status: 302, headers: { location: "https://evil.example.test/feed.xml" } });
    }
    if (url.includes("sec.gov")) return new Response(`
      <feed><entry><title>8-K filing</title><link href="https://www.sec.gov/Archives/edgar/data/1/report.htm" />
      <id>sec-entry-1</id><updated>2026-08-13</updated></entry>
      <entry><title>malicious</title><link href="javascript:alert(1)" /><id>bad</id></entry></feed>
    `);
    throw new Error(`Unexpected request ${url}`);
  };
  const result = await new FinanceSourceRegistry(dataDir, fakeFetch as typeof fetch).collect(usPreferences);
  expect(result.items.map((item) => item.link)).toEqual(["https://www.sec.gov/Archives/edgar/data/1/report.htm"]);
  expect(result.warnings.join(" ")).toContain("origin allowlist");
  expect(requested.some((url) => url.includes("evil.example.test"))).toBe(false);
  await rm(dataDir, { recursive: true, force: true });
});

test("finance source streaming limit rejects oversized bodies without trusting Content-Length", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-size-"));
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("cninfo.com.cn")) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2_000_000));
          controller.enqueue(new Uint8Array(2_000_000));
          controller.close();
        },
      }));
    }
    if (url.includes("csrc.gov.cn")) return new Response(`<a href="/csrc/c100028/c1/content.shtml">证监会发布监管措施</a>`);
    if (url.includes("pbc.gov.cn")) return new Response(`<a href="/goutongjiaoliu/113456/113469/1/index.html">人民银行货币政策公告</a>`);
    return new Response(`<a href="./zxfb/202608/t20260809_1.html" title="2026年7月份CPI发布">CPI发布</a>`);
  };
  const result = await new FinanceSourceRegistry(dataDir, fakeFetch as typeof fetch).collect(preferences);
  expect(result.warnings.join(" ")).toContain("exceeded 3000000 bytes");
  expect(result.items.length).toBeGreaterThan(0);
  await rm(dataDir, { recursive: true, force: true });
});
