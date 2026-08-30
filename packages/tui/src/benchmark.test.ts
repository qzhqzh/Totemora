import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  loadLocalConfig,
  type AgentProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderRegistry,
} from "@totemora/core";

import { loadBenchmarkSuite, runBenchmark } from "./benchmark";

test("cross-domain proof suite keeps twelve tasks and resolvable evidence workspaces", async () => {
  const loaded = await loadBenchmarkSuite("benchmarks/cross-domain-proof-v1.json");
  expect(loaded.suite.tasks).toHaveLength(12);
  expect(new Set(loaded.suite.tasks.map((task) => task.workspace))).toEqual(new Set([
    "../examples/demo-project",
    "../examples/operations-incident",
    "../examples/finance-evidence",
    "../examples/editorial-review",
    "../examples/agent-governance",
  ]));
  for (const task of loaded.suite.tasks) {
    const workspace = resolve(dirname(loaded.path), task.workspace);
    for (const evidence of task.expected_evidence) {
      expect((await readFile(resolve(workspace, evidence), "utf8")).length).toBeGreaterThan(0);
    }
  }
});

test("benchmark compares strong, cheap, and tribe strategies on the same task", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-benchmark-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "# Demo\nEvidence.\n");
  const suitePath = join(root, "suite.json");
  await writeFile(suitePath, JSON.stringify({
    schema_version: 1,
    id: "test-suite",
    version: 1,
    tasks: [{
      id: "inspect",
      goal: "分析 Demo",
      workspace: "./workspace",
      acceptance: ["引用真实文件"],
      expected_evidence: ["README.md"],
      required_claims: ["找到文件证据"],
      forbidden_claims: ["秘密答案"],
    }],
  }));
  const config = await loadLocalConfig({ configDir: "configs/example" });
  const provider = new BenchmarkProvider();
  const output = await runBenchmark({
    suitePath,
    config,
    providers: new SharedRegistry(provider),
    dataDir,
    strongMemberId: "deepseek_reasoner",
    cheapMemberId: "qwen_worker",
    chiefMemberId: "deepseek_reasoner",
    maxContextBytes: 32_000,
    maxMembers: 1,
    maxTotalTokens: 50_000,
  });
  expect(output.result.results).toHaveLength(3);
  expect(output.result.results.every((item) => item.structural_passed)).toBe(true);
  expect(output.result.summary.single_strong).toMatchObject({ structural_passed: 1, total_tokens: 10, strong_model_tokens: 10 });
  expect(output.result.summary.single_cheap).toMatchObject({ structural_passed: 1, total_tokens: 10, strong_model_tokens: 0 });
  expect(output.result.summary.tribe.structural_passed).toBe(1);
  expect(output.result.summary.tribe.strong_model_tokens).toBeGreaterThan(0);
  expect(output.result.budget.max_output_tokens_per_call).toBe(2_000);
  expect(output.result.budget).toMatchObject({
    max_context_bytes: 32_000,
    max_members_per_tribe_case: 1,
    max_total_tokens_per_tribe_case: 50_000,
  });
  expect(provider.maxTokens.every((value) => value === 2_000)).toBe(true);
  const initialPrompts = [
    ...provider.prompts.filter((prompt) => prompt.includes("可重复评测")),
    provider.prompts.find((prompt) => !prompt.includes("可重复评测")) ?? "",
  ];
  expect(initialPrompts.every((prompt) =>
    !prompt.includes("找到文件证据") && !prompt.includes("秘密答案"),
  )).toBe(true);
  expect(JSON.parse(await readFile(output.jsonPath, "utf8")).suite.id).toBe("test-suite");
  expect(await readFile(output.markdownPath, "utf8")).toContain("| tribe | 1/1 |");
  expect(await readFile(output.markdownPath, "utf8")).toContain("Max total tokens per tribe case: 50000");
  const tribeRunId = output.result.results.find((item) => item.strategy === "tribe")?.run_id;
  expect(tribeRunId).toBeTruthy();
  expect(JSON.parse(await readFile(join(dataDir, "runs", `${tribeRunId}.json`), "utf8")).task.budget).toMatchObject({
    max_context_bytes: 32_000,
    max_members: 1,
    max_total_tokens: 50_000,
  });
  await rm(root, { recursive: true, force: true });
});

test("benchmark preserves measured usage when a model returns malformed JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-benchmark-usage-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "# Demo\nEvidence.\n");
  const suitePath = join(root, "suite.json");
  await writeFile(suitePath, JSON.stringify({
    schema_version: 1,
    id: "usage-suite",
    version: 1,
    tasks: [{
      id: "inspect",
      goal: "分析 Demo",
      workspace: "./workspace",
      acceptance: ["引用真实文件"],
      expected_evidence: ["README.md"],
    }],
  }));
  const config = await loadLocalConfig({ configDir: "configs/example" });
  const output = await runBenchmark({
    suitePath,
    config,
    providers: new SharedRegistry(new MalformedDirectProvider()),
    dataDir: join(root, "data"),
    strongMemberId: "deepseek_reasoner",
    cheapMemberId: "qwen_worker",
  });
  expect(output.result.results.find((item) => item.strategy === "single_strong")).toMatchObject({
    status: "failed",
    calls: 1,
    total_tokens: 10,
    strong_model_tokens: 10,
    usage_status: "measured",
  });
  await rm(root, { recursive: true, force: true });
});

test("benchmark prices measured calls only from an explicit dated snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "totemora-benchmark-pricing-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "# Demo\nEvidence.\n");
  const suitePath = join(root, "suite.json");
  await writeFile(suitePath, JSON.stringify({
    schema_version: 1, id: "priced-suite", version: 1,
    tasks: [{ id: "inspect", goal: "分析 Demo", workspace: "./workspace",
      acceptance: ["引用真实文件"], expected_evidence: ["README.md"] }],
  }));
  const pricingPath = join(root, "pricing.json");
  await writeFile(pricingPath, JSON.stringify({
    schema_version: 1, id: "test-prices", as_of: "2026-08-12T00:00:00.000Z",
    source: "test fixture", currency: "USD",
    models: [
      { provider: "deepseek", model: "deepseek-v4-pro[1m]", input_usd_per_million: 1, output_usd_per_million: 2 },
      { provider: "qwen", model: "qwen3.7-plus", input_usd_per_million: 1, output_usd_per_million: 2 },
      { provider: "xiaomi", model: "mimo-v2.5-pro", input_usd_per_million: 1, output_usd_per_million: 2 },
    ],
  }));
  const config = await loadLocalConfig({ configDir: "configs/example" });
  const output = await runBenchmark({
    suitePath, pricingSnapshotPath: pricingPath, config,
    providers: new SharedRegistry(new BenchmarkProvider()), dataDir: join(root, "data"),
    strongMemberId: "deepseek_reasoner", cheapMemberId: "qwen_worker",
  });
  expect(output.result.pricing_status).toBe("configured");
  expect(output.result.pricing_snapshot).toMatchObject({ id: "test-prices", currency: "USD" });
  expect(output.result.results.find((item) => item.strategy === "single_strong")).toMatchObject({
    pricing_status: "configured", estimated_cost_usd: 0.000014, strong_model_cost_usd: 0.000014,
  });
  expect(output.result.summary.single_strong).toMatchObject({ known_cost_usd: 0.000014, pricing_gap_cases: 0 });
  await rm(root, { recursive: true, force: true });
});

class SharedRegistry implements ProviderRegistry {
  constructor(private readonly provider: AgentProvider) {}
  get(): AgentProvider { return this.provider; }
}

class BenchmarkProvider implements AgentProvider {
  private chiefCalls = 0;
  readonly maxTokens: number[] = [];
  readonly prompts: string[] = [];

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.maxTokens.push(request.maxTokens ?? 0);
    this.prompts.push(request.messages.map((message) => message.content).join("\n"));
    const isDirectBenchmark = request.messages.some((message) => message.content.includes("可重复评测"));
    if (isDirectBenchmark) return response(report());
    if (request.memberId === "deepseek_reasoner") {
      this.chiefCalls += 1;
      if (this.chiefCalls === 1) {
        return response({
          summary: "委派只读检查",
          assignments: [{
            id: "inspect-readme",
            member_id: "mimo_scout",
            role: "scout",
            instruction: "检查 README",
            acceptance: ["引用真实文件"],
            skills: ["fact-checking"],
            assignment_reason: "米探适合读取文件",
            selection_factors: ["reading", "cost"],
          }],
        });
      }
      return response(report());
    }
    if (request.memberId === "qwen_worker" && request.responseFormat === "json") {
      return response({ outcome: "accepted", rationale: "证据满足要求", issues: [] });
    }
    return response("README.md 包含 Demo 证据。");
  }
}

class MalformedDirectProvider extends BenchmarkProvider {
  override async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.messages.some((message) => message.content.includes("可重复评测"))) {
      return response("{");
    }
    return super.generate(request);
  }
}

function report() {
  return {
    title: "Demo 分析",
    summary: "找到文件证据。",
    findings: [{ claim: "存在说明", evidence: ["README.md: Evidence"] }],
    recommendations: [],
    acceptance_review: [{ criterion: "引用真实文件", status: "passed", evidence: "README.md" }],
  };
}

function response(value: unknown): ModelResponse {
  return {
    content: typeof value === "string" ? value : JSON.stringify(value),
    usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
  };
}
