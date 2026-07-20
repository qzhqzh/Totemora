import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig, type AgentProvider } from "@totemora/core";
import { IntelligenceService } from "./intelligence-service";
import { MemberStateStore } from "./member-state-store";

test("intelligence member collects allowlisted RSS and journals three Bark pushes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-url"), "https://api.day.app/test-device\n", "utf8");
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
    if (url.includes("api.day.app")) return new Response('{"code":200}');
    if (url.includes("news.google.com")) return new Response("unavailable", { status: 503 });
    return new Response(rss, { headers: { "content-type": "application/rss+xml" } });
  };
  const state = new MemberStateStore(dataDir, config);
  const service = new IntelligenceService(config, { get: () => provider }, state, dataDir, resolve(import.meta.dir, "../../.."), fakeFetch as typeof fetch);
  const brief = await service.run({ message_count: 3, idempotency_key: "test-brief" });
  expect(brief).toMatchObject({ status: "completed", member_id: "qwen_intelligence", pushed_messages: 3, warnings: ["News source failed (503): news.google.com"] });
  expect(requests.filter((url) => url.includes("api.day.app"))).toHaveLength(3);
  expect((await state.getDossier("qwen_intelligence")).growth.verified_successes).toBe(1);
  await rm(dataDir, { recursive: true, force: true });
});

test("intelligence member corrects an out-of-evidence URL once before pushing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-intelligence-correction-"));
  await mkdir(join(dataDir, "secrets"), { recursive: true });
  await writeFile(join(dataDir, "secrets", "bark-url"), "https://api.day.app/test-device\n", "utf8");
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
    if (String(input).includes("api.day.app")) { pushes += 1; return new Response('{"code":200}'); }
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
