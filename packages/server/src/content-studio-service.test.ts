import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig, type AgentProvider } from "@totemora/core";
import { ContentStudioService, type ContentIllustrationGenerator, type ContentStudioPreferences } from "./content-studio-service";
import { IntelligenceCandidateStore } from "./intelligence-candidate-store";
import { MemberStateStore } from "./member-state-store";
import { StateDatabase } from "./state-database";

test("content studio records research, writing, review, and illustration evidence before an X post becomes ready", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-studio-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const sourceUrl = "https://example.com/hotspot";
  const candidate = (await new IntelligenceCandidateStore(dataDir).ingest({
    scan_id: "scan-1", member_id: "qwen_intelligence", push_threshold: 0.7, history_hours: 72,
    evaluations: [{
      event_key: "agent-change", headline: "Agent 工具链出现变化", brief: "新版本加入可恢复任务状态。",
      url: sourceUrl, source: "test", importance: 0.9, interest: 0.9, confidence: 0.9,
      novelty: 0.9, push_worthy: true, rationale: "与常驻 Agent 有关", is_update: false,
    }],
  }))[0]!;
  const provider: AgentProvider = { async generate(request) {
    if (request.memberId === "cpa_illustrator") return { content: JSON.stringify({
      scene: "小角色把三块恢复状态拼成桥", metaphor: "恢复能力是一座可续接的桥",
      composition: "大面积白底，角色位于左下，三块状态石通向右侧",
      character_action: "蹲下连接状态石", palette: ["black", "purple", "warm gray"],
      alt_text: "黑发紫眼的小角色把状态、幂等键和回执拼成一座可续接的桥。", avoid: ["text", "logo"],
    }) };
    if (request.memberId === "qwen_worker") return { content: JSON.stringify({
      title: "Agent 任务恢复值得关注",
      body: `Agent 工具链开始把“中断后能否继续”当成基础能力。对常驻服务而言，这比一次跑完更重要。先观察状态是否持久化、重试是否幂等。来源：${sourceUrl}`,
      excerpt: "常驻 Agent 更需要可恢复，而不是只追求一次成功。", hashtags: ["AIAgent", "工程实践"],
    }), usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 } };
    const reviewing = request.messages.at(-1)?.content.includes("你是与写作者不同的审校成员");
    return reviewing
      ? { content: JSON.stringify({ outcome: "accepted", rationale: "来源保留且没有扩写事实", issues: [] }) }
      : { content: JSON.stringify({
        angle: "从常驻系统的恢复能力切入", audience: "Agent 工程实践者",
        facts: ["新版本加入可恢复任务状态"], outline: ["变化", "为什么重要", "观察项"], risks: ["仅有单一来源"],
      }) };
  } };
  const state = new MemberStateStore(dataDir, config);
  const illustrationGenerator: ContentIllustrationGenerator = { async generate(input) {
    input.onProgress?.("generating", 1);
    input.onProgress?.("reviewing", 1);
    return {
      data: Buffer.from("illustration"), mime_type: "image/png", width: 1024, height: 1024,
      image_model: "gemini-3.1-flash-image", prompt: "test prompt", attempts: 1,
      reference_set: ["character.png"],
      review: { outcome: "accepted", semantic_score: 0.9, style_score: 0.85, line_quality_score: 0.8, rationale: "通过", issues: [] },
    };
  } };
  const service = new ContentStudioService(config, { get: () => provider }, state, dataDir, illustrationGenerator);
  const queued = await service.createQueued({ format: "x_hot_post", source_candidate_id: candidate.id });
  const ready = await service.execute(queued.id);

  expect(ready.status).toBe("ready");
  expect(ready.body).toContain(sourceUrl);
  expect([...ready.body!].length).toBeLessThanOrEqual(280);
  expect(new Set(ready.contributions.map((item) => item.member_id)).size).toBe(3);
  expect(ready.assignments).toEqual([
    expect.objectContaining({ member_id: "qwen_intelligence", role: "researcher_reviewer" }),
    expect.objectContaining({ member_id: "qwen_worker", role: "writer" }),
    expect.objectContaining({ member_id: "cpa_illustrator", role: "illustrator" }),
  ]);
  expect(ready.illustration).toMatchObject({ status: "ready", member_id: "cpa_illustrator", width: 1024, attempt_count: 1 });
  expect((await service.readIllustration(ready.id))?.data.toString()).toBe("illustration");
  expect(ready.review?.outcome).toBe("accepted");
  expect(ready.usage.calls).toBe(5);
  expect((await state.getDossier("qwen_worker")).growth.experience_credit).toBe(0);

  const copied = await service.markCopied(ready.id);
  expect(copied.copy_count).toBe(1);
  expect((await state.getDossier("qwen_worker")).growth.experience_credit).toBe(0.5);
  expect((await state.getDossier("qwen_intelligence")).growth.experience_credit).toBe(0.5);
  expect((await state.getDossier("cpa_illustrator")).growth.experience_credit).toBe(0.5);
  await rm(dataDir, { recursive: true, force: true });
});

test("irregular content scheduling reserves the next window and avoids reused candidates", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-schedule-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const candidate = (await new IntelligenceCandidateStore(dataDir).ingest({
    scan_id: "scan-schedule", member_id: "qwen_intelligence", push_threshold: 0.7, history_hours: 72,
    evaluations: [{
      event_key: "schedule-hotspot", headline: "计划测试热点", brief: "一个高可信候选。",
      url: "https://example.com/scheduled", source: "test", importance: 0.9, interest: 0.9,
      confidence: 0.9, novelty: 0.9, push_worthy: true, rationale: "test", is_update: false,
    }],
  }))[0]!;
  const state = new MemberStateStore(dataDir, config);
  const service = new ContentStudioService(config, { get: () => ({ generate: async () => ({ content: "{}" }) }) }, state, dataDir);
  service.savePreferences({ enabled: true, min_interval_hours: 1, max_interval_hours: 2, formats: ["longform_tutorial"] });
  StateDatabase.open(dataDir).putRecord("content:settings", "default", {
    ...service.preferences(), next_run_at: new Date(0).toISOString(),
  } satisfies ContentStudioPreferences);

  const due = await service.dueInput(new Date());
  expect(due).toEqual({ format: "longform_tutorial", source_candidate_id: candidate.id });
  expect(Date.parse(service.preferences().next_run_at!)).toBeGreaterThan(Date.now());
  expect(await service.dueInput(new Date())).toBeUndefined();
  await rm(dataDir, { recursive: true, force: true });
});

test("scheduled content skips low-value candidates instead of manufacturing an article", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-quality-gate-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  await new IntelligenceCandidateStore(dataDir).ingest({
    scan_id: "scan-low-value", member_id: "qwen_intelligence", push_threshold: 0.7, history_hours: 72,
    evaluations: [{
      event_key: "minor-rewording", headline: "普通产品文案调整", brief: "没有实质变化。",
      url: "https://example.com/minor", source: "test", importance: 0.35, interest: 0.4,
      confidence: 0.8, novelty: 0.3, push_worthy: false, rationale: "缺少新增事实", is_update: false,
    }],
  });
  const state = new MemberStateStore(dataDir, config);
  const service = new ContentStudioService(config, { get: () => ({ generate: async () => ({ content: "{}" }) }) }, state, dataDir);
  service.savePreferences({ enabled: true, min_interval_hours: 6, max_interval_hours: 18, formats: ["x_hot_post"] });
  StateDatabase.open(dataDir).putRecord("content:settings", "default", {
    ...service.preferences(), next_run_at: new Date(0).toISOString(),
  } satisfies ContentStudioPreferences);

  expect(await service.dueInput(new Date())).toBeUndefined();
  expect(Date.parse(service.preferences().next_run_at!)).toBeGreaterThan(Date.now());
  expect(service.list()).toHaveLength(0);
  await rm(dataDir, { recursive: true, force: true });
});

test("content studio produces a reviewed long-form tutorial from a manual topic", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-content-longform-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const article = [
    "# 常驻 Agent 的恢复设计",
    "## 已知边界\n当前选题由用户给出，没有外部来源，因此以下内容是工程经验推导，不是新闻事实。",
    ...Array.from({ length: 16 }, (_, index) => `## 步骤 ${index + 1}\n把任务状态、幂等键和外部回执分开保存。进程中断后先核对已经发生的副作用，再决定恢复、等待人工确认或安全重试。每一步都记录输入、负责人、时间与验收结果。`),
    "## 待验证项\n需要在真实故障注入中测量恢复成功率和重复副作用比例。",
  ].join("\n\n");
  const provider: AgentProvider = { async generate(request) {
    if (request.memberId === "cpa_illustrator") return { content: JSON.stringify({
      scene: "小角色连接空白积木", metaphor: "可恢复流程", composition: "大留白",
      character_action: "连接积木", palette: ["white", "purple"],
      alt_text: "小角色用积木连接可恢复流程。", avoid: ["text"],
    }) };
    if (request.memberId === "qwen_worker") return { content: JSON.stringify({
      title: "常驻 Agent 的恢复设计", body: article,
      excerpt: "从状态、幂等和回执三个层次设计可恢复任务。", hashtags: ["Agent", "可靠性"],
    }) };
    return request.messages.at(-1)?.content.includes("你是与写作者不同的审校成员")
      ? { content: JSON.stringify({ outcome: "accepted", rationale: "明确标记了经验推导和待验证项", issues: [] }) }
      : { content: JSON.stringify({
        angle: "用故障恢复框架整理实践", audience: "Agent 服务开发者",
        facts: ["当前没有外部来源证据"], outline: ["边界", "方法", "验证"], risks: ["不能写成热点事实"],
      }) };
  } };
  const state = new MemberStateStore(dataDir, config);
  const failedIllustration: ContentIllustrationGenerator = { async generate() { throw new Error("image gate failed"); } };
  const service = new ContentStudioService(config, { get: () => provider }, state, dataDir, failedIllustration);
  const queued = await service.createQueued({ format: "longform_tutorial", topic: "常驻 Agent 的恢复设计" });
  const ready = await service.execute(queued.id);
  expect(ready).toMatchObject({ status: "ready", title: "常驻 Agent 的恢复设计" });
  expect(ready.illustration).toMatchObject({ status: "failed", error: "image gate failed" });
  expect([...ready.body!].length).toBeGreaterThan(600);
  expect(new Set(ready.contributions.map((item) => item.member_id)).size).toBe(3);
  await service.markCopied(ready.id);
  expect((await state.getDossier("qwen_worker")).growth.experience_credit).toBe(0.5);
  expect((await state.getDossier("cpa_illustrator")).growth.experience_credit).toBe(0);
  await rm(dataDir, { recursive: true, force: true });
});
