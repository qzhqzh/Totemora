import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig, type AgentProvider } from "@totemora/core";
import { IntelligenceService } from "./intelligence-service";
import { IntelligencePreferenceStore } from "./intelligence-preference-store";
import { MemberStateStore } from "./member-state-store";
import { StateDatabase } from "./state-database";

test("intelligence member collects allowlisted RSS and journals three Bark pushes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "test-device\n", "utf8");
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const provider: AgentProvider = { async generate() { return { content: JSON.stringify({
    title: "测试情报", summary: "三个来源出现值得关注的变化。",
    items: [
      { headline: "变化一", brief: "需要继续观察。", url: "https://example.com/a" },
      { headline: "变化二", brief: "影响开发工具。", url: "https://example.com/b" },
      { headline: "变化三", brief: "尚未完全确认。", url: "https://example.com/a" },
    ],
  }) }; } };
  const rss = "<rss><channel><item><title>News A</title><link>https://example.com/a</link><pubDate>today</pubDate></item><item><title>News B</title><link>https://example.com/b</link></item></channel></rss>";
  const requests: string[] = [];
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    if (url.includes("127.0.0.1:18080")) return new Response('{"code":200}');
    if (url.includes("news.google.com")) return new Response("unavailable", { status: 503 });
    return new Response(rss, { headers: { "content-type": "application/rss+xml" } });
  };
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch);
  const brief = await service.run({ message_count: 3, idempotency_key: "test-brief" });
  expect(brief).toMatchObject({ status: "completed", member_id: "qwen_intelligence", pushed_messages: 3 });
  expect(brief.warnings).toContain("News source failed (503): news.google.com");
  expect(requests.filter((url) => url.includes("127.0.0.1:18080"))).toHaveLength(3);
  expect((await state.getDossier("qwen_intelligence")).growth).toMatchObject({
    verified_successes: 0,
    experience_credit: 0,
    operation_count: 1,
  });
  await rm(dataDir, { recursive: true, force: true });
});

test("intelligence member corrects an out-of-evidence URL once before pushing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-correction-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "test-device\n", "utf8");
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let attempts = 0;
  const provider: AgentProvider = { async generate() {
    attempts += 1;
    return { content: JSON.stringify({
      title: "纠正测试", summary: "来源出现变化。",
      items: [{ headline: "变化", brief: "继续观察。", url: attempts === 1 ? "https://invented.example/news" : "https://example.com/a" }],
    }) };
  } };
  const rss = "<rss><channel><item><title>News A</title><link>https://example.com/a</link></item></channel></rss>";
  let pushes = 0;
  const fakeFetch = async (input: string | URL | Request) => {
    if (String(input).includes("127.0.0.1:18080")) { pushes += 1; return new Response('{"code":200}'); }
    return new Response(rss);
  };
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch);
  const brief = await service.run({ idempotency_key: "correction-brief" });
  expect(attempts).toBe(2);
  expect(pushes).toBe(1);
  expect(brief.status).toBe("completed");
  expect(brief.items[0]?.url).toBe("https://example.com/a");
  expect(brief.warnings).toContain("情报员经过一次证据边界纠正后完成摘要");
  await rm(dataDir, { recursive: true, force: true });
});

test("scheduled intelligence claims a ten-minute window before slow model work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-lease-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "test-device\n", "utf8");
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let generations = 0;
  const provider: AgentProvider = { async generate() {
    generations += 1;
    await new Promise((done) => setTimeout(done, 20));
    return { content: JSON.stringify({ title: "定时情报", summary: "一次运行。", items: [{ headline: "变化", brief: "观察。", url: "https://example.com/a" }] }) };
  } };
  const rss = "<rss><channel><item><title>News A</title><link>https://example.com/a</link></item></channel></rss>";
  const fakeFetch = async (input: string | URL | Request) => String(input).includes("127.0.0.1:18080") ? new Response("ok") : new Response(rss);
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch);
  const [first, duplicate] = await Promise.all([service.runDue(), service.runDue()]);
  expect([first, duplicate].filter((item) => item?.scan?.status === "completed")).toHaveLength(1);
  expect([first, duplicate].filter((item) => item === undefined)).toHaveLength(1);
  expect(generations).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});

test("a Bark delivery failure does not prevent the next scheduled scan", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-push-isolation-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "test-device\n", "utf8");
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const provider: AgentProvider = { async generate() { return { content: JSON.stringify({
    title: "候选情报", summary: "可验证变化。", items: [{
      headline: "重要变化", brief: "值得关注。", url: "https://example.com/a", event_key: crypto.randomUUID(),
      importance: 1, interest: 1, confidence: 1, novelty: 1, push_worthy: true, rationale: "高价值", is_update: false,
    }],
  }) }; } };
  const rss = "<rss><channel><item><title>News A</title><link>https://example.com/a</link></item></channel></rss>";
  const fakeFetch = async (input: string | URL | Request) => String(input).includes("127.0.0.1:18080")
    ? new Response("unavailable", { status: 503 }) : new Response(rss);
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch);
  await service.run({ defer_push: true });
  const result = await service.runDue();
  expect(result?.scan?.status).toBe("completed");
  expect(result?.push_error).toContain("Bark push failed (503)");
  expect((await state.getDossier("qwen_intelligence")).growth.system_failures).toBeGreaterThanOrEqual(1);
  await rm(dataDir, { recursive: true, force: true });
});

test("a Telegram retry does not duplicate a Bark delivery that already succeeded", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-multichannel-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-device-key"), "test-device\n");
  await writeFile(join(dataDir, "secrets", "telegram-bot-token"), "123456:test_token\n");
  await writeFile(join(dataDir, "secrets", "telegram-chat-ids"), "-100123\n");
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const provider: AgentProvider = { async generate() { return { content: JSON.stringify({
    title: "多通道候选", summary: "一次候选。", items: [{
      headline: "同一候选", brief: "只应推送一次 Bark。", url: "https://example.com/a",
      event_key: "multi-channel-case", importance: 1, interest: 1, confidence: 1, novelty: 1,
      push_worthy: true, rationale: "high value", is_update: false,
    }],
  }) }; } };
  const rss = "<rss><channel><item><title>News A</title><link>https://example.com/a</link></item></channel></rss>";
  let barkPushes = 0;
  let telegramPushes = 0;
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("127.0.0.1:18080")) { barkPushes += 1; return Response.json({ code: 200 }); }
    if (url.includes("api.telegram.org")) {
      telegramPushes += 1;
      return telegramPushes === 1
        ? Response.json({ ok: false, error_code: 503, description: "temporary" }, { status: 503 })
        : Response.json({ ok: true, result: { message_id: 9 } });
    }
    return new Response(rss);
  };
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(
    config, { get: () => provider }, state, dataDir,
    resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch,
  );
  const brief = await service.run({ defer_push: true });
  const push = (service as unknown as { pushNextCandidate(interval: number): Promise<unknown> }).pushNextCandidate.bind(service);
  await expect(push(0)).rejects.toThrow("Telegram API sendMessage failed");
  StateDatabase.open(dataDir).db.query(`
    UPDATE intelligence_candidates SET next_attempt_at=? WHERE scan_id=?
  `).run(new Date(0).toISOString(), brief.id);
  await push(0);
  expect(barkPushes).toBe(1);
  expect(telegramPushes).toBe(2);
  await rm(dataDir, { recursive: true, force: true });
});

test("optional X and Weibo channels join RSS evidence without exposing tokens", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-social-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "x-bearer-token"), "x-secret\n", "utf8");
  await writeFile(join(dataDir, "secrets", "weibo-access-token"), "weibo-secret\n", "utf8");
  await new IntelligencePreferenceStore(dataDir).save({ interests: ["AI"], channels: { rss: true, x_trends: true, weibo_hot: true }, x_woeid: 1 });
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let prompt = "";
  const provider: AgentProvider = { async generate(input) {
    prompt = input.messages.at(-1)?.content ?? "";
    return { content: JSON.stringify({ title: "社交热点", summary: "AI 热点。", items: [
      { headline: "X AI", brief: "X 热点。", url: "https://x.com/search?q=%23AI&src=trend_click" },
      { headline: "微博 AI", brief: "微博热点。", url: "https://s.weibo.com/weibo?q=AI%E5%8A%A9%E6%89%8B" },
    ] }) };
  } };
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.x.com")) return Response.json({ data: [{ trend_name: "#AI", tweet_count: 10 }] });
    if (url.includes("api.weibo.com")) return Response.json([{ trends: [{ name: "AI助手" }] }]);
    return new Response("<rss><channel><item><title>News A</title><link>https://example.com/a</link></item></channel></rss>");
  };
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch);
  const brief = await service.run();
  expect(brief.sources.map((item) => item.source)).toContain("x.com");
  expect(brief.sources.map((item) => item.source)).toContain("weibo.com");
  expect(prompt).toContain('用户关注方向：["AI"]');
  expect(prompt).not.toContain("x-secret");
  expect(prompt).not.toContain("weibo-secret");
  await rm(dataDir, { recursive: true, force: true });
});

test("AI HOT uses fingerprint caching and preserves original plus aggregator attribution", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-aihot-"));
  await new IntelligencePreferenceStore(dataDir).save({
    interests: ["AI Agent"],
    channels: { rss: false, ai_hot: true, x_trends: false, weibo_hot: false },
    x_woeid: 1,
  });
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let prompt = "";
  const provider: AgentProvider = { async generate(input) {
    prompt = input.messages.at(-1)?.content ?? "";
    return { content: JSON.stringify({
      title: "AI HOT 精选",
      summary: "发现一条值得复核的 Agent 更新。",
      items: [{
        headline: "Agent 运行时更新",
        brief: "上游摘要提示运行时发生变化，应回原文复核。",
        url: "https://primary.example.com/agent-runtime",
      }],
    }) };
  } };
  let itemRequests = 0;
  const userAgents: string[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    userAgents.push(new Headers(init?.headers).get("user-agent") ?? "");
    if (url.endsWith("/api/public/fingerprint")) return Response.json({ selected: "f1-test" });
    if (url.includes("/api/public/items")) {
      itemRequests += 1;
      return Response.json({ items: [{
        id: "item-1",
        title: "Agent 运行时更新",
        url: "https://primary.example.com/agent-runtime",
        permalink: "https://aihot.virxact.com/items/item-1",
        source: "Primary Lab（RSS）",
        publishedAt: "2026-07-23T12:00:00.000Z",
        summary: "这是 AI 生成的聚合摘要。",
        category: "ai-products",
        score: 78,
        attribution: { source: "AI HOT", canonical: "https://aihot.virxact.com/items/item-1" },
      }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(
    config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch,
  );
  const first = await service.run({ defer_push: true });
  const second = await service.run({ defer_push: true });
  expect(first.sources[0]).toMatchObject({
    link: "https://primary.example.com/agent-runtime",
    source: "AI HOT · Primary Lab（RSS）",
    canonical: "https://aihot.virxact.com/items/item-1",
    upstream_score: 78,
  });
  expect(second.status).toBe("completed");
  expect(itemRequests).toBe(1);
  expect(userAgents.every((value) => value.startsWith("Totemora-Intelligence/"))).toBe(true);
  expect(prompt).toContain("https://aihot.virxact.com/items/item-1");
  expect(prompt).toContain("这是 AI 生成的聚合摘要");
  await rm(dataDir, { recursive: true, force: true });
});

test("AI watch filters unrelated general news before model evaluation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-scope-"));
  await new IntelligencePreferenceStore(dataDir).save({
    interests: ["AI Agent"],
    channels: { rss: true, ai_hot: false, x_trends: false, weibo_hot: false },
    x_woeid: 1,
  });
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let prompt = "";
  const provider: AgentProvider = { async generate(input) {
    prompt = input.messages.at(-1)?.content ?? "";
    return { content: JSON.stringify({
      title: "AI 更新", summary: "开发工具出现新变化。",
      items: [{ headline: "AI 编程助手更新", brief: "增加 Agent 能力。", url: "https://example.com/ai-tool" }],
    }) };
  } };
  const fakeFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("technology")) return new Response("<rss><channel><item><title>AI coding tool update</title><link>https://example.com/ai-tool</link></item></channel></rss>");
    if (url.includes("hnrss.org")) return new Response("<rss><channel></channel></rss>");
    return new Response("<rss><channel><item><title>White House staffing change</title><link>https://example.com/politics</link></item></channel></rss>");
  };
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch);
  const brief = await service.run({ defer_push: true });
  expect(brief.sources.map((item) => item.link)).toEqual(["https://example.com/ai-tool"]);
  expect(prompt).not.toContain("White House staffing change");
  await rm(dataDir, { recursive: true, force: true });
});

test("AI watch treats an all-out-of-scope scan as a healthy no-op", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-empty-scope-"));
  await new IntelligencePreferenceStore(dataDir).save({
    interests: ["AI Agent"],
    channels: { rss: true, ai_hot: false, x_trends: false, weibo_hot: false },
    x_woeid: 1,
  });
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let generations = 0;
  const provider: AgentProvider = { async generate() { generations += 1; return { content: "{}" }; } };
  const rss = "<rss><channel><item><title>White House staffing change</title><link>https://example.com/politics</link></item></channel></rss>";
  const fakeFetch = (async (input: string | URL | Request) =>
    new Response(String(input).includes("technology") || String(input).includes("hnrss.org")
      ? "<rss><channel></channel></rss>" : rss)) as unknown as typeof fetch;
  const service = new IntelligenceService(
    config, { get: () => provider }, new MemberStateStore(dataDir, config), dataDir,
    resolve(import.meta.dir, "../../.."), fakeFetch,
  );
  const brief = await service.run({ defer_push: true });
  expect(brief).toMatchObject({
    status: "completed", title: "听风巡查 · 无新增",
    source_gate: { collected: 2, out_of_scope: 2, model_evaluated: 0 },
  });
  expect(generations).toBe(0);
  await rm(dataDir, { recursive: true, force: true });
});

test("AI watch skips the model when every collected source was already evaluated", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-pre-model-dedupe-"));
  await new IntelligencePreferenceStore(dataDir).save({
    interests: ["AI Agent"],
    channels: { rss: true, ai_hot: false, x_trends: false, weibo_hot: false },
    x_woeid: 1,
  });
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  let generations = 0;
  const provider: AgentProvider = { async generate() {
    generations += 1;
    return { content: JSON.stringify({
      title: "Agent 更新", summary: "出现新版本。",
      items: [{
        headline: "OpenAI 发布新的 Agent 模型", brief: "模型加入新的工具能力。",
        url: "https://example.com/agent-model", event_key: "openai-agent-model",
      }],
    }) };
  } };
  const rss = "<rss><channel><item><title>OpenAI 发布新的 Agent 模型</title><link>https://example.com/agent-model</link></item></channel></rss>";
  const fakeFetch = (async () => new Response(rss)) as unknown as typeof fetch;
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch);
  await service.run({ defer_push: true });
  const repeated = await service.run({ defer_push: true });
  expect(generations).toBe(1);
  expect(repeated).toMatchObject({ status: "completed", title: "听风巡查 · 无新增", queued_messages: 0 });
  expect(repeated.warnings).toContain("预模型历史门禁过滤 1 条已评估来源");
  await rm(dataDir, { recursive: true, force: true });
});
