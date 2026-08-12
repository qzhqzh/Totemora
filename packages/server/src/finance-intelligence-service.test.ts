import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig, type AgentProvider } from "@totemora/core";
import {
  buildFinanceMessages,
  FinanceIntelligenceService,
  financeAdviceViolation,
  financeBriefingsDue,
  type FinanceIntelligenceBrief,
} from "./finance-intelligence-service";
import { parseMarketSnapshotResponse } from "./finance-market-snapshot-service";
import { FinancePreferenceStore } from "./finance-preference-store";
import { IntelligenceDispatcher } from "./intelligence-dispatcher";
import { MemberStateStore } from "./member-state-store";
import { StateDatabase } from "./state-database";

test.each([
  "建议继续持有该标的",
  "建议维持五成仓位",
  "建议在10元止损",
  "可以在12元设置止盈位",
  "预计收益率可达20%，值得配置该股票",
])("deterministic finance gate rejects action advice: %s", (brief) => {
  expect(financeAdviceViolation({
    title: "财经观察", summary: "仅供信息整理，不构成投资建议。",
    items: [{ headline: "事件", brief, url: "https://example.com", rationale: "test" }],
  })).toBeDefined();
});

test("deterministic finance gate permits factual disclosure language", () => {
  expect(financeAdviceViolation({
    title: "公司披露回购事项", summary: "仅供信息整理，不构成投资建议。",
    items: [{
      headline: "公司发布回购公告", brief: "公告说明回购进度；建议关注公司收益变化和后续执行情况。",
      url: "https://example.com", rationale: "来自法定披露平台",
    }],
  })).toBeUndefined();
  expect(financeAdviceViolation({
    title: "国债市场观察", summary: "值得观察十年期国债收益率变化。",
    items: [{
      headline: "十年期国债收益率变化", brief: "下一步可以观察收益率曲线和官方政策信号。",
      url: "https://example.com", rationale: "来自官方宏观发布",
    }],
  })).toBeUndefined();
});

test("finance morning briefings use Asia/Shanghai weekday windows", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-schedule-"));
  const preferences = await new FinancePreferenceStore(dataDir).get();
  expect(financeBriefingsDue(new Date("2026-08-12T23:05:00.000Z"), preferences)).toEqual([
    { type: "asia_preopen", local_date: "2026-08-13" },
  ]);
  expect(financeBriefingsDue(new Date("2026-08-13T00:05:00.000Z"), preferences)).toEqual([
    { type: "us_overnight", local_date: "2026-08-13" },
  ]);
  expect(financeBriefingsDue(new Date("2026-08-15T00:05:00.000Z"), preferences)).toEqual([
    { type: "us_overnight", local_date: "2026-08-15" },
  ]);
  expect(financeBriefingsDue(new Date("2026-08-16T00:05:00.000Z"), preferences)).toEqual([]);
  await rm(dataDir, { recursive: true, force: true });
});

test("观潮 turns official finance evidence into a domain-isolated candidate", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-service-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  await new FinancePreferenceStore(dataDir).save({
    interests: ["半导体", "监管"], markets: ["CN"],
    watchlist: [{ market: "CN", symbol: "688209", name: "英集芯" }],
    channels: { disclosures: true, regulation: true, macro: true, global_official: false, market_media: false },
  });
  const provider: AgentProvider = { async generate(input) {
    expect(input.memberId).toBe("qwen_finance");
    return { content: JSON.stringify({
      title: "财经官方变化", summary: "一项自选公告和宏观变化值得观察，不构成投资建议。",
      items: [{
        headline: "A股 688209 · 回购相关公告", brief: "公司披露回购相关股东信息；下一步观察回购执行。",
        url: "https://www.cninfo.com.cn/new/disclosure/detail?stockCode=688209&announcementId=1225470190&announcementTime=2026-08-13",
        event_key: "CN:688209:buyback", importance: 0.8, interest: 1, confidence: 0.9, novelty: 0.9,
        push_worthy: true, rationale: "命中自选，来自法定披露平台", is_update: false,
      }],
    }) };
  } };
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("cninfo.com.cn")) return new Response(`<a href="/new/disclosure/detail?stockCode=688209&announcementId=1225470190&announcementTime=2026-08-13">英集芯关于回购事项的公告</a>`);
    if (url.includes("csrc.gov.cn")) return new Response(`<a href="/csrc/c100028/c7649078/content.shtml">中国证监会发布资本市场监管新规</a>`);
    if (url.includes("pbc.gov.cn")) return new Response(`<a href="/goutongjiaoliu/113456/113469/123/index.html">中国人民银行发布货币政策公告</a>`);
    return new Response(`<a href="./zxfb/202608/t20260809_1965008.html" title="2026年7月份居民消费价格同比上涨0.5%">CPI</a>`);
  };
  const state = new MemberStateStore(dataDir, config);
  const service = new FinanceIntelligenceService(
    config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch,
  );
  const brief = await service.run({ defer_push: true, reason: "manual" });
  expect(brief).toMatchObject({ domain: "finance", member_id: "qwen_finance", status: "completed", queued_messages: 1 });
  expect((await service.listCandidates())[0]).toMatchObject({
    domain: "finance", market: "CN", symbols: ["688209"], evidence_tier: "S0", event_type: "ownership_change",
  });
  expect((await state.getDossier("qwen_finance")).growth).toMatchObject({ verified_successes: 0, operation_count: 1 });
  expect(await service.runDue()).toBeUndefined();
  await rm(dataDir, { recursive: true, force: true });
});

test("观潮 corrects prohibited investment advice before a candidate can be stored", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-safety-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  await new FinancePreferenceStore(dataDir).save({ markets: ["CN"] });
  const sourceUrl = "https://www.cninfo.com.cn/new/disclosure/detail?stockCode=688209&announcementId=1225470190&announcementTime=2026-08-13";
  let calls = 0;
  const provider: AgentProvider = { async generate() {
    calls += 1;
    return { content: JSON.stringify({
      title: "财经官方变化", summary: "仅供信息整理，不构成投资建议。",
      items: [{
        headline: "A股 688209 · 回购公告", url: sourceUrl,
        brief: calls === 1 ? "公司发布公告，建议立即买入并设置目标价。" : "公司发布回购公告；下一步观察执行进度。",
        importance: 0.9, interest: 1, confidence: 0.9, novelty: 0.9, push_worthy: true,
        rationale: "重大公告", is_update: false,
      }],
    }) };
  } };
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("cninfo.com.cn")) return new Response(`<a href="/new/disclosure/detail?stockCode=688209&announcementId=1225470190&announcementTime=2026-08-13">英集芯关于回购事项的公告</a>`);
    if (url.includes("csrc.gov.cn")) return new Response(`<a href="/csrc/c100028/c7649078/content.shtml">中国证监会发布资本市场监管新规</a>`);
    if (url.includes("pbc.gov.cn")) return new Response(`<a href="/goutongjiaoliu/113456/113469/123/index.html">中国人民银行发布货币政策公告</a>`);
    return new Response(`<a href="./zxfb/202608/t20260809_1965008.html" title="2026年7月份居民消费价格同比上涨0.5%">CPI</a>`);
  };
  const service = new FinanceIntelligenceService(
    config, { get: () => provider }, new MemberStateStore(dataDir, config), dataDir,
    resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch,
  );
  const brief = await service.run({ defer_push: true, reason: "manual" });
  expect(calls).toBe(2);
  expect(brief.items[0]?.brief).not.toContain("买入");
  expect(brief.warnings).toContain("观潮经过一次确定性门禁纠正后完成评估");
  await rm(dataDir, { recursive: true, force: true });
});

test("finance delivery requires both specialist and channel asset permissions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-permission-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "device-secret\n");
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const member = config.agents.agents.find((candidate) => candidate.id === "qwen_finance")!;
  member.tools = member.tools?.filter((tool) => tool !== "internal-bark");
  const provider: AgentProvider = { async generate() { throw new Error("provider must not run"); } };
  const service = new FinanceIntelligenceService(
    config, { get: () => provider }, new MemberStateStore(dataDir, config), dataDir,
    resolve(import.meta.dir, "../../.."), (async () => Response.json({ code: 200 })) as unknown as typeof fetch,
  );
  await expect(service.run({ defer_push: false })).rejects.toThrow("internal-bark");
  await rm(dataDir, { recursive: true, force: true });
});

test("scheduled morning delivery retries only incomplete Bark targets without rerunning the model", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-finance-morning-retry-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-targets.json"), JSON.stringify([
    { id: "flaky", device_key: "flaky-key", domains: ["finance"], enabled: true, server_url: "https://flaky.example.test" },
    { id: "healthy", device_key: "healthy-key", domains: ["finance"], enabled: true, server_url: "https://healthy.example.test" },
  ]));
  await new FinancePreferenceStore(dataDir).save({ markets: ["US"] });
  const requests: string[] = [];
  let flakyAttempts = 0;
  const fetchImpl = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("flaky.example.test") && flakyAttempts++ === 0) return new Response("unavailable", { status: 503 });
    return Response.json({ code: 200 });
  }) as typeof fetch;
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const memberState = new MemberStateStore(dataDir, config);
  const capturedAt = "2026-08-13T00:05:00.000Z";
  const latest = Date.parse("2026-08-12T13:30:00.000Z") / 1_000;
  const snapshot = parseMarketSnapshotResponse(marketPayload(latest), capturedAt);
  const deliveryKey = "scheduled:2026-08-13:us_overnight";
  const brief: FinanceIntelligenceBrief = {
    id: "morning-retry", domain: "finance", member_id: "qwen_finance",
    title: "观潮晨报 · 隔夜美股", summary: "模型错误声称标普上涨 99%", disclaimer: "仅供信息整理，不构成投资建议。",
    items: [{ headline: "来源事件", brief: "来源事实", url: "https://example.com/source" }],
    sources: [], warnings: [], pushed_messages: 0, status: "failed", created_at: capturedAt,
    briefing_type: "us_overnight", market_snapshot: snapshot,
    delivery_idempotency_key: deliveryKey, delivery_pending: true, error: "flaky target failed",
  };
  const message = buildFinanceMessages(brief, 1)[0]!;
  expect(message.body).not.toContain("99%");
  expect(message.body.endsWith(brief.disclaimer)).toBe(true);
  const dispatcher = new IntelligenceDispatcher(dataDir, memberState, fetchImpl);
  await expect(dispatcher.pushDirect("finance", deliveryKey, 0, brief.member_id, message)).rejects.toThrow("unavailable");
  StateDatabase.open(dataDir).putRecord("finance_intelligence_briefs", brief.id, brief, brief.created_at, brief.created_at);
  let providerCalls = 0;
  const provider: AgentProvider = { async generate() { providerCalls += 1; throw new Error("provider must not rerun"); } };
  const service = new FinanceIntelligenceService(
    config, { get: () => provider }, memberState, dataDir, resolve(import.meta.dir, "../../.."), fetchImpl,
  );
  expect(await service.runDue(new Date(capturedAt))).toMatchObject({
    scan: { id: brief.id, status: "completed", delivery_pending: false, pushed_messages: 1 },
  });
  expect(providerCalls).toBe(0);
  expect(requests.filter((url) => url.includes("healthy.example.test"))).toHaveLength(1);
  expect(requests.filter((url) => url.includes("flaky.example.test"))).toHaveLength(2);
  await rm(dataDir, { recursive: true, force: true });
});

function marketPayload(latest: number): string {
  const symbols = ["^GSPC", "^IXIC", "^DJI", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY"];
  return JSON.stringify({ spark: { result: symbols.map((symbol, index) => ({
    symbol,
    response: [{ timestamp: [latest - 86_400, latest], indicators: { quote: [{ close: [100, 101 + index] }] } }],
  })) } });
}
