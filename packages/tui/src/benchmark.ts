import {
  FileRunStore,
  TribeRuntime,
  collectWorkspaceSnapshot,
  type AgentProvider,
  type LocalConfigSet,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ProviderRegistry,
  type TaskReport,
  type WorkspaceSnapshot,
} from "@totemora/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export type BenchmarkStrategy = "single_strong" | "single_cheap" | "tribe";

export interface BenchmarkSuite {
  schema_version: 1;
  id: string;
  version: number;
  description?: string;
  tasks: BenchmarkTask[];
}

export interface BenchmarkTask {
  id: string;
  goal: string;
  workspace: string;
  acceptance: string[];
  expected_evidence: string[];
  required_claims?: string[];
  forbidden_claims?: string[];
}

export interface BenchmarkResult {
  schema_version: 1;
  id: string;
  created_at: string;
  suite: { id: string; version: number; task_count: number };
  members: { strong: string; cheap: string; chief: string };
  budget: { max_output_tokens_per_call: number };
  results: BenchmarkCaseResult[];
  summary: Record<BenchmarkStrategy, BenchmarkStrategySummary>;
  pricing_status: "configured" | "partial" | "unconfigured";
  pricing_snapshot?: { id: string; as_of: string; source: string; currency: "USD" };
}

export interface BenchmarkPricingSnapshot {
  schema_version: 1;
  id: string;
  as_of: string;
  source: string;
  currency: "USD";
  models: Array<{
    provider: string;
    model: string;
    input_usd_per_million: number;
    output_usd_per_million: number;
  }>;
}

export interface BenchmarkCaseResult {
  task_id: string;
  strategy: BenchmarkStrategy;
  status: "completed" | "failed";
  structural_passed: boolean;
  score: number;
  acceptance_passed: number;
  acceptance_total: number;
  evidence_passed: number;
  evidence_total: number;
  required_claims_passed: number;
  required_claims_total: number;
  forbidden_claims_passed: number;
  forbidden_claims_total: number;
  latency_ms: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  strong_model_tokens: number;
  usage_status: "measured" | "partial" | "unknown";
  pricing_status: "configured" | "partial" | "unconfigured";
  estimated_cost_usd?: number;
  strong_model_cost_usd?: number;
  error?: string;
  report?: TaskReport;
  run_id?: string;
}

interface BenchmarkStrategySummary {
  attempted: number;
  structural_passed: number;
  structural_pass_rate: number;
  total_tokens: number;
  strong_model_tokens: number;
  latency_ms: number;
  failures: number;
  usage_unknown_cases: number;
  known_cost_usd: number;
  pricing_gap_cases: number;
}

interface EmberIdentity {
  provider: string;
  model: string;
}

interface UsageRecord extends EmberIdentity {
  member_id: string;
  usage?: ModelUsage;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
const SAFE_BENCHMARK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function loadBenchmarkSuite(path: string): Promise<{ suite: BenchmarkSuite; path: string }> {
  const absolutePath = resolve(path);
  const suite = JSON.parse(await readFile(absolutePath, "utf8")) as BenchmarkSuite;
  if (suite.schema_version !== 1 || !SAFE_BENCHMARK_ID.test(suite.id) || !Number.isInteger(suite.version)) {
    throw new Error("Benchmark suite requires schema_version=1, id, and integer version");
  }
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) {
    throw new Error("Benchmark suite requires at least one task");
  }
  const ids = new Set<string>();
  for (const task of suite.tasks) {
    if (!SAFE_BENCHMARK_ID.test(task.id) || ids.has(task.id)) throw new Error(`Invalid or duplicate benchmark task id: ${task.id}`);
    if (!task.goal?.trim() || !task.workspace?.trim()) throw new Error(`Benchmark task ${task.id} requires goal and workspace`);
    if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) throw new Error(`Benchmark task ${task.id} requires acceptance criteria`);
    if (!Array.isArray(task.expected_evidence) || task.expected_evidence.length === 0) throw new Error(`Benchmark task ${task.id} requires expected_evidence`);
    if (task.required_claims && !Array.isArray(task.required_claims)) throw new Error(`Benchmark task ${task.id} required_claims must be an array`);
    if (task.forbidden_claims && !Array.isArray(task.forbidden_claims)) throw new Error(`Benchmark task ${task.id} forbidden_claims must be an array`);
    ids.add(task.id);
  }
  return { suite, path: absolutePath };
}

export async function loadPricingSnapshot(path: string): Promise<BenchmarkPricingSnapshot> {
  const snapshot = JSON.parse(await readFile(resolve(path), "utf8")) as BenchmarkPricingSnapshot;
  if (snapshot.schema_version !== 1 || !snapshot.id?.trim() || snapshot.currency !== "USD"
    || !Number.isFinite(Date.parse(snapshot.as_of)) || !snapshot.source?.trim()
    || !Array.isArray(snapshot.models) || snapshot.models.length === 0) {
    throw new Error("Pricing snapshot requires schema_version=1, id, as_of, source, USD currency, and model rates");
  }
  const identities = new Set<string>();
  for (const item of snapshot.models) {
    const identity = `${item.provider}/${item.model}`;
    if (!item.provider?.trim() || !item.model?.trim() || identities.has(identity)
      || !Number.isFinite(item.input_usd_per_million) || item.input_usd_per_million < 0
      || !Number.isFinite(item.output_usd_per_million) || item.output_usd_per_million < 0) {
      throw new Error(`Invalid or duplicate pricing rate: ${identity}`);
    }
    identities.add(identity);
  }
  return snapshot;
}

export async function runBenchmark(input: {
  suitePath: string;
  config: LocalConfigSet;
  providers: ProviderRegistry;
  dataDir: string;
  strongMemberId: string;
  cheapMemberId: string;
  chiefMemberId?: string;
  maxFiles?: number;
  maxContextBytes?: number;
  maxOutputTokens?: number;
  pricingSnapshotPath?: string;
}): Promise<{ result: BenchmarkResult; jsonPath: string; markdownPath: string }> {
  const loaded = await loadBenchmarkSuite(input.suitePath);
  const pricing = input.pricingSnapshotPath ? await loadPricingSnapshot(input.pricingSnapshotPath) : undefined;
  const chiefMemberId = input.chiefMemberId ?? input.strongMemberId;
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const strongMember = requireMember(input.config, input.strongMemberId);
  const strongEmber = { provider: strongMember.provider, model: strongMember.model };
  const members = {
    strong: strongMember.id,
    cheap: requireMember(input.config, input.cheapMemberId).id,
    chief: requireMember(input.config, chiefMemberId).id,
  };
  const results: BenchmarkCaseResult[] = [];
  for (const [taskIndex, task] of loaded.suite.tasks.entries()) {
    const workspacePath = resolve(dirname(loaded.path), task.workspace);
    const workspace = await collectWorkspaceSnapshot(workspacePath, {
      maxFiles: input.maxFiles,
      maxTotalBytes: input.maxContextBytes,
    });
    const order = strategyOrder(taskIndex);
    for (const strategy of order) {
      if (strategy === "single_strong") {
        results.push(await runSingle(task, workspace, strategy, members.strong, strongEmber, input, maxOutputTokens, pricing));
      } else if (strategy === "single_cheap") {
        results.push(await runSingle(task, workspace, strategy, members.cheap, strongEmber, input, maxOutputTokens, pricing));
      } else {
        results.push(await runTribe(task, workspace, members.chief, strongEmber, input, maxOutputTokens, pricing));
      }
    }
  }
  const result: BenchmarkResult = {
    schema_version: 1,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    suite: { id: loaded.suite.id, version: loaded.suite.version, task_count: loaded.suite.tasks.length },
    members,
    budget: { max_output_tokens_per_call: maxOutputTokens },
    results,
    summary: summarize(results),
    pricing_status: !pricing ? "unconfigured"
      : results.every((item) => item.pricing_status === "configured") ? "configured" : "partial",
    ...(pricing ? { pricing_snapshot: {
      id: pricing.id, as_of: pricing.as_of, source: pricing.source, currency: pricing.currency,
    } } : {}),
  };
  const outputDir = resolve(input.dataDir, "benchmarks");
  await mkdir(outputDir, { recursive: true });
  const stem = `${loaded.suite.id}-v${loaded.suite.version}-${result.id}`;
  const jsonPath = resolve(outputDir, `${stem}.json`);
  const markdownPath = resolve(outputDir, `${stem}.md`);
  for (const path of [jsonPath, markdownPath]) {
    const child = relative(outputDir, path);
    if (!child || child.startsWith("..") || resolve(outputDir, child) !== path) {
      throw new Error("Benchmark output path escaped its data directory");
    }
  }
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderBenchmarkMarkdown(result), "utf8");
  return { result, jsonPath, markdownPath };
}

async function runSingle(
  task: BenchmarkTask,
  workspace: WorkspaceSnapshot,
  strategy: "single_strong" | "single_cheap",
  memberId: string,
  strongEmber: EmberIdentity,
  input: Parameters<typeof runBenchmark>[0],
  maxOutputTokens: number,
  pricing?: BenchmarkPricingSnapshot,
): Promise<BenchmarkCaseResult> {
  const member = requireMember(input.config, memberId);
  const meter = new MeteredProviderRegistry(input.providers, pricing);
  const startedAt = performance.now();
  try {
    const response = await meter.get(member.provider).generate({
      memberId: member.id,
      model: member.model,
      responseFormat: "json",
      maxTokens: maxOutputTokens,
      messages: [
        {
          role: "system",
          content: [
            member.persona ?? `你是 ${member.id}。`,
            "你正在参加可重复评测。只能根据给定只读 Workspace 作答，不得声称修改或执行了文件。",
            "输出严格 JSON：{title,summary,findings:[{claim,evidence:[string]}],recommendations:[{priority,action,reason}],acceptance_review:[{criterion,status,evidence}]}。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `目标：${task.goal}`,
            `验收标准：${JSON.stringify(task.acceptance)}`,
            `Workspace：${JSON.stringify(workspace)}`,
            "acceptance_review 必须逐字包含每一条验收标准，status 只能是 passed、partial、failed。",
          ].join("\n"),
        },
      ],
    });
    const report = parseTaskReport(response.content);
    const score = scoreReport(task, report);
    return {
      task_id: task.id, strategy, status: "completed",
      structural_passed: score.structural_passed, score: score.score,
      ...score.counts, latency_ms: Math.round(performance.now() - startedAt),
      ...meter.metrics(strongEmber),
      report,
    };
  } catch (error) {
    return failedCase(task, strategy, performance.now() - startedAt, error, meter.metrics(strongEmber));
  }
}

async function runTribe(
  task: BenchmarkTask,
  workspace: WorkspaceSnapshot,
  chiefMemberId: string,
  strongEmber: EmberIdentity,
  input: Parameters<typeof runBenchmark>[0],
  maxOutputTokens: number,
  pricing?: BenchmarkPricingSnapshot,
): Promise<BenchmarkCaseResult> {
  const meter = new MeteredProviderRegistry(input.providers, pricing);
  const startedAt = performance.now();
  try {
    const runtime = new TribeRuntime(
      input.config,
      meter,
      new FileRunStore(input.dataDir),
    );
    const run = await runtime.runTask({
      id: `benchmark_${task.id}_${crypto.randomUUID()}`,
      goal: task.goal,
      acceptance: task.acceptance,
      workspace,
      constraints: { read_only: true },
      budget: {
        max_context_bytes: input.maxContextBytes,
        max_output_tokens_per_call: maxOutputTokens,
      },
    }, chiefMemberId);
    if (!run.final_report) throw new Error("Tribe benchmark completed without a report");
    const score = scoreReport(task, run.final_report);
    return {
      task_id: task.id, strategy: "tribe", status: "completed",
      structural_passed: score.structural_passed, score: score.score,
      ...score.counts, latency_ms: Math.round(performance.now() - startedAt),
      ...meter.metrics(strongEmber),
      report: run.final_report,
      run_id: run.id,
    };
  } catch (error) {
    return failedCase(task, "tribe", performance.now() - startedAt, error, meter.metrics(strongEmber));
  }
}

function scoreReport(task: BenchmarkTask, report: TaskReport) {
  const acceptancePassed = task.acceptance.filter((criterion) =>
    report.acceptance_review.some((item) => item.criterion === criterion && item.status === "passed"),
  ).length;
  const evidence = report.findings.flatMap((finding) => finding.evidence);
  const evidencePassed = task.expected_evidence.filter((path) =>
    evidence.some((item) => item.includes(path)),
  ).length;
  const reportText = JSON.stringify(report);
  const requiredClaimsPassed = (task.required_claims ?? []).filter((claim) => reportText.includes(claim)).length;
  const forbiddenClaimsPassed = (task.forbidden_claims ?? []).filter((claim) => !reportText.includes(claim)).length;
  const total = task.acceptance.length + task.expected_evidence.length
    + (task.required_claims?.length ?? 0) + (task.forbidden_claims?.length ?? 0);
  const structuralPassed = acceptancePassed === task.acceptance.length
    && evidencePassed === task.expected_evidence.length
    && requiredClaimsPassed === (task.required_claims?.length ?? 0)
    && forbiddenClaimsPassed === (task.forbidden_claims?.length ?? 0);
  return {
    structural_passed: structuralPassed,
    score: total
      ? Math.round(((acceptancePassed + evidencePassed + requiredClaimsPassed + forbiddenClaimsPassed) / total) * 1000) / 1000
      : 0,
    counts: {
      acceptance_passed: acceptancePassed,
      acceptance_total: task.acceptance.length,
      evidence_passed: evidencePassed,
      evidence_total: task.expected_evidence.length,
      required_claims_passed: requiredClaimsPassed,
      required_claims_total: task.required_claims?.length ?? 0,
      forbidden_claims_passed: forbiddenClaimsPassed,
      forbidden_claims_total: task.forbidden_claims?.length ?? 0,
    },
  };
}

function parseTaskReport(content: string): TaskReport {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  const report = JSON.parse(start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced) as TaskReport;
  if (!report.title || !report.summary || !Array.isArray(report.findings)
    || !Array.isArray(report.recommendations) || !Array.isArray(report.acceptance_review)) {
    throw new Error("Benchmark model returned an invalid TaskReport");
  }
  return report;
}

function failedCase(
  task: BenchmarkTask,
  strategy: BenchmarkStrategy,
  latency: number,
  error: unknown,
  usage: ReturnType<MeteredProviderRegistry["metrics"]>,
): BenchmarkCaseResult {
  return {
    task_id: task.id, strategy, status: "failed", structural_passed: false, score: 0,
    acceptance_passed: 0, acceptance_total: task.acceptance.length,
    evidence_passed: 0, evidence_total: task.expected_evidence.length,
    required_claims_passed: 0, required_claims_total: task.required_claims?.length ?? 0,
    forbidden_claims_passed: 0, forbidden_claims_total: task.forbidden_claims?.length ?? 0,
    latency_ms: Math.round(latency), ...usage,
    error: error instanceof Error ? error.message : String(error),
  };
}

function summarize(results: BenchmarkCaseResult[]): Record<BenchmarkStrategy, BenchmarkStrategySummary> {
  return Object.fromEntries((["single_strong", "single_cheap", "tribe"] as const).map((strategy) => {
    const rows = results.filter((result) => result.strategy === strategy);
    const structuralPassed = rows.filter((result) => result.structural_passed).length;
    return [strategy, {
      attempted: rows.length,
      structural_passed: structuralPassed,
      structural_pass_rate: rows.length ? Math.round((structuralPassed / rows.length) * 1000) / 1000 : 0,
      total_tokens: rows.reduce((sum, row) => sum + row.total_tokens, 0),
      strong_model_tokens: rows.reduce((sum, row) => sum + row.strong_model_tokens, 0),
      latency_ms: rows.reduce((sum, row) => sum + row.latency_ms, 0),
      failures: rows.filter((result) => result.status === "failed").length,
      usage_unknown_cases: rows.filter((result) => result.usage_status !== "measured").length,
      known_cost_usd: roundUsd(rows.reduce((sum, row) => sum + (row.estimated_cost_usd ?? 0), 0)),
      pricing_gap_cases: rows.filter((result) => result.pricing_status !== "configured").length,
    }];
  })) as Record<BenchmarkStrategy, BenchmarkStrategySummary>;
}

function strategyOrder(taskIndex: number): BenchmarkStrategy[] {
  const orders: BenchmarkStrategy[][] = [
    ["single_strong", "single_cheap", "tribe"],
    ["single_cheap", "tribe", "single_strong"],
    ["tribe", "single_strong", "single_cheap"],
  ];
  return orders[taskIndex % orders.length]!;
}

function requireMember(config: LocalConfigSet, memberId: string) {
  const member = config.agents.agents.find((item) => item.id === memberId);
  if (!member || ["inactive", "retired"].includes(member.status ?? "active")) {
    throw new Error(`Benchmark member is unavailable: ${memberId}`);
  }
  return member;
}

function renderBenchmarkMarkdown(result: BenchmarkResult): string {
  const rows = (["single_strong", "single_cheap", "tribe"] as const).map((strategy) => {
    const item = result.summary[strategy];
    const knownCost = item.attempted > item.pricing_gap_cases ? item.known_cost_usd.toFixed(6) : "unknown";
    return `| ${strategy} | ${item.structural_passed}/${item.attempted} | ${(item.structural_pass_rate * 100).toFixed(1)}% | ${item.total_tokens} | ${item.strong_model_tokens} | ${knownCost} | ${item.pricing_gap_cases} | ${item.latency_ms} | ${item.failures} | ${item.usage_unknown_cases} |`;
  });
  return [
    `# Totemora Benchmark · ${result.suite.id} v${result.suite.version}`,
    "",
    `- Run: \`${result.id}\``,
    `- Created: ${result.created_at}`,
    `- Strong / cheap / chief: \`${result.members.strong}\` / \`${result.members.cheap}\` / \`${result.members.chief}\``,
    `- Max output tokens per call: ${result.budget.max_output_tokens_per_call}`,
    result.pricing_status === "unconfigured"
      ? "- Pricing: unconfigured; no cost value is fabricated."
      : `- Pricing: ${result.pricing_status}; snapshot ${result.pricing_snapshot?.id} as of ${result.pricing_snapshot?.as_of} (${result.pricing_snapshot?.source}).`,
    "",
    "| Strategy | Structural passed | Structural pass rate | Total tokens | Strong-model tokens | Known cost USD | Pricing gaps | Latency ms | Failures | Usage gaps |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Cases",
    "",
    ...result.results.map((item) =>
      `- \`${item.task_id}\` / **${item.strategy}**: ${item.structural_passed ? "STRUCTURAL PASS" : "FAIL"} · score ${item.score} · tokens ${item.total_tokens} (${item.usage_status}) · cost ${item.estimated_cost_usd === undefined ? "unknown" : `$${item.estimated_cost_usd.toFixed(6)}`} · ${item.latency_ms} ms${item.error ? ` · ${item.error}` : ""}`,
    ),
    "",
    "## Scoring boundary",
    "",
    "当前 scorer 验证验收项、证据路径、必需事实和禁用断言；它仍不把模型自述当作业务正确性的完整证明，因此指标命名为 structural pass rate。usage 为 partial/unknown 时，零值不能解释为零消耗。后续代码变更任务应接入隔离环境中的确定性测试 scorer。",
    "",
  ].join("\n");
}

class MeteredProviderRegistry implements ProviderRegistry {
  private readonly records: UsageRecord[] = [];

  constructor(
    private readonly base: ProviderRegistry,
    private readonly pricing?: BenchmarkPricingSnapshot,
  ) {}

  get(providerId: string): AgentProvider {
    const provider = this.base.get(providerId);
    return {
      generate: async (request: ModelRequest): Promise<ModelResponse> => {
        const record: UsageRecord = {
          provider: providerId,
          model: request.model,
          member_id: request.memberId,
        };
        this.records.push(record);
        const response = await provider.generate(request);
        record.usage = response.usage;
        return response;
      },
    };
  }

  metrics(strongEmber: EmberIdentity) {
    const measured = this.records.filter((record) => typeof record.usage?.totalTokens === "number");
    const usageStatus = measured.length === this.records.length && this.records.length > 0
      ? "measured"
      : measured.length > 0
        ? "partial"
        : "unknown";
    const sum = (field: keyof ModelUsage) =>
      measured.reduce((total, record) => total + (record.usage?.[field] ?? 0), 0);
    const priceable = this.records.filter((record) =>
      typeof record.usage?.inputTokens === "number"
      && typeof record.usage?.outputTokens === "number"
      && this.pricing?.models.some((rate) => rate.provider === record.provider && rate.model === record.model),
    );
    const pricingStatus = !this.pricing ? "unconfigured"
      : priceable.length === this.records.length && this.records.length > 0 ? "configured" : "partial";
    const cost = (records: UsageRecord[]) => roundUsd(records.reduce((total, record) => {
      const rate = this.pricing?.models.find((item) => item.provider === record.provider && item.model === record.model);
      if (!rate || !record.usage) return total;
      return total + ((record.usage.inputTokens ?? 0) * rate.input_usd_per_million
        + (record.usage.outputTokens ?? 0) * rate.output_usd_per_million) / 1_000_000;
    }, 0));
    return {
      calls: this.records.length,
      input_tokens: sum("inputTokens"),
      output_tokens: sum("outputTokens"),
      total_tokens: sum("totalTokens"),
      strong_model_tokens: measured
        .filter((record) => record.provider === strongEmber.provider && record.model === strongEmber.model)
        .reduce((total, record) => total + (record.usage?.totalTokens ?? 0), 0),
      usage_status: usageStatus as "measured" | "partial" | "unknown",
      pricing_status: pricingStatus as "configured" | "partial" | "unconfigured",
      ...(pricingStatus === "configured" ? {
        estimated_cost_usd: cost(priceable),
        strong_model_cost_usd: cost(priceable.filter((record) =>
          record.provider === strongEmber.provider && record.model === strongEmber.model)),
      } : {}),
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
