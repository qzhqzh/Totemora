import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { attributeFailure } from "../packages/core/src/index";
import { OpenAICompatibleProvider } from "../packages/providers/src/index";
import { createPlaygroundApp } from "../packages/server/src/app";
import { BarkNotificationService } from "../packages/server/src/bark-notification-service";
import { JobStore } from "../packages/server/src/job-store";
import { RecurringServiceRunner } from "../packages/server/src/recurring-service-runner";
import { RecurringServiceStateRepository } from "../packages/server/src/recurring-service-state-repository";
import { SpecialistTaskRepository } from "../packages/server/src/specialist-service";

export interface StabilityDrillScenario {
  id: string;
  status: "passed" | "failed";
  duration_ms: number;
  evidence?: Record<string, unknown>;
  error?: string;
}

export interface StabilityDrillReport {
  schema_version: 1;
  id: string;
  created_at: string;
  scenarios: StabilityDrillScenario[];
  summary: { attempted: number; passed: number; failed: number };
}

export async function runStabilityDrills(options: {
  dataDir: string;
  configDir?: string;
}): Promise<{ report: StabilityDrillReport; jsonPath: string; markdownPath: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), "totemora-stability-drill-"));
  const configDir = options.configDir ?? resolve(import.meta.dir, "../configs/example");
  const scenarios: StabilityDrillScenario[] = [];
  try {
    scenarios.push(await scenario("provider-degradation", () => providerDegradation()));
    scenarios.push(await scenario("recurring-isolation-and-restart", () => recurringIsolation(join(sandbox, "recurring"))));
    scenarios.push(await scenario("gateway-task-restart", () => gatewayTaskRestart(join(sandbox, "gateway"), configDir)));
    scenarios.push(await scenario("bark-circuit-breaker", () => barkCircuitBreaker(join(sandbox, "bark"))));
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }

  const passed = scenarios.filter((item) => item.status === "passed").length;
  const report: StabilityDrillReport = {
    schema_version: 1,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    scenarios,
    summary: { attempted: scenarios.length, passed, failed: scenarios.length - passed },
  };
  const outputDir = resolve(options.dataDir, "stability-drills");
  await mkdir(outputDir, { recursive: true });
  const stem = `stability-drill-${report.created_at.replace(/[:.]/g, "-")}-${report.id.slice(0, 8)}`;
  const jsonPath = join(outputDir, `${stem}.json`);
  const markdownPath = join(outputDir, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  return { report, jsonPath, markdownPath };
}

async function providerDegradation(): Promise<Record<string, unknown>> {
  const provider = new OpenAICompatibleProvider({
    id: "drill-provider",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "drill-placeholder",
  }, async () => new Response("temporary upstream timeout", { status: 504 }));
  let failure: unknown;
  try {
    await provider.generate({
      memberId: "drill-member",
      model: "drill-model",
      maxTokens: 32,
      messages: [{ role: "user", content: "health probe" }],
    });
  } catch (error) {
    failure = error;
  }
  const attribution = attributeFailure(failure);
  assert(attribution.category === "provider", "Provider 504 was not attributed to the provider boundary");
  assert(attribution.retryable, "Provider 504 was not marked retryable");
  return { upstream_status: 504, category: attribution.category, retryable: attribution.retryable };
}

async function recurringIsolation(dataDir: string): Promise<Record<string, unknown>> {
  const calls = { finance: 0, content: 0 };
  const persistence = new RecurringServiceStateRepository(dataDir);
  const runner = new RecurringServiceRunner([
    { id: "intelligence.watch", interval_ms: 1_000, async run() { throw new Error("source unavailable"); } },
    { id: "finance.watch", interval_ms: 1_000, async run() { calls.finance += 1; } },
    { id: "content.studio", interval_ms: 1_000, async run() { calls.content += 1; } },
  ], persistence);
  const outcomes = await Promise.all([
    runner.tick("intelligence.watch"),
    runner.tick("finance.watch"),
    runner.tick("content.studio"),
  ]);
  assert(outcomes.join(",") === "failed,completed,completed", "Recurring services were not failure-isolated");
  assert(calls.finance === 1 && calls.content === 1, "Healthy recurring services did not run once");

  const prior = persistence.load("finance.watch")!;
  persistence.save({ ...prior, running: true, last_started_at: new Date().toISOString() });
  const restarted = new RecurringServiceRunner([
    { id: "finance.watch", interval_ms: 1_000, async run() {} },
  ], persistence).status()[0]!;
  assert(!restarted.running && restarted.failures === prior.failures + 1, "Restart did not close the running tick as failed");
  return {
    outcomes,
    healthy_service_calls: calls,
    restart_running: restarted.running,
    restart_failures: restarted.failures,
  };
}

async function gatewayTaskRestart(dataDir: string, configDir: string): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const task = {
    id: "drill-interrupted-git",
    kind: "git_flow" as const,
    status: "running" as const,
    created_at: now,
    updated_at: now,
    workplace_id: "drill-workplace",
    goal: "prepare a safe commit",
    mode: "commit" as const,
    issue_mode: "none" as const,
  };
  await new JobStore<typeof task, { workplace_id: string; goal: string }>(dataDir, "development-tasks")
    .save(task, { workplace_id: task.workplace_id, goal: task.goal });
  const specialistTasks = new SpecialistTaskRepository(dataDir);
  specialistTasks.create({
    id: task.id,
    service_id: "git.flow",
    service_version: 1,
    operation: "commit",
    trigger: "web",
    status: "running",
    current_stage: "inspect",
    chief_member_id: "drill-chief",
    input: { workplace_id: task.workplace_id },
  });
  const app = createPlaygroundApp({
    configDir,
    dataDir,
    operatorToken: "drill-operator",
    createProviderRegistry: () => ({
      get: () => ({ async generate() { throw new Error("Provider must not run during restart recovery"); } }),
    }),
  });
  const response = await app.fetch(new Request(`http://local/api/development/tasks/${task.id}`, {
    headers: { authorization: "Bearer drill-operator" },
  }));
  const recovered = await response.json() as { status?: string; retryable?: boolean };
  const envelope = specialistTasks.get(task.id);
  assert(response.status === 200 && recovered.status === "failed" && recovered.retryable === true,
    "Interrupted domain task was not recovered as retryable failure");
  assert(envelope?.status === "failed" && envelope.current_stage === "failed",
    "Specialist task envelope diverged from the recovered domain task");
  return { domain_status: recovered.status, retryable: recovered.retryable, specialist_status: envelope.status };
}

async function barkCircuitBreaker(dataDir: string): Promise<Record<string, unknown>> {
  const targetsEnvironment = process.env.TOTEMORA_BARK_TARGETS_JSON;
  delete process.env.TOTEMORA_BARK_TARGETS_JSON;
  try {
    const targetPath = join(dataDir, "secrets", "bark-targets.json");
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, JSON.stringify([{
      id: "drill-target",
      label: "Drill target",
      device_key: "drill-device-key",
      domains: ["ai"],
      enabled: true,
      server_url: "http://127.0.0.1:18080",
    }]), { encoding: "utf8", mode: 0o600 });
    let fetchCalls = 0;
    const service = new BarkNotificationService(dataDir, (async () => {
      fetchCalls += 1;
      return new Response("channel unavailable", { status: 503 });
    }) as typeof fetch);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await service.pushTo("drill-target", { title: "drill", body: "fault injection" });
      } catch {}
    }
    const status = await service.status(false, "ai");
    const target = status.targets.find((item) => item.id === "drill-target");
    assert(fetchCalls === 3, "Open Bark circuit still called the external channel");
    assert(target?.channel_status === "open" && target.consecutive_failures === 3,
      "Bark failures did not open the circuit after three attempts");
    const serialized = JSON.stringify(status);
    assert(!serialized.includes("drill-device-key"), "Bark status exposed a complete device key");
    return { external_calls: fetchCalls, channel_status: target.channel_status, consecutive_failures: 3 };
  } finally {
    if (targetsEnvironment === undefined) delete process.env.TOTEMORA_BARK_TARGETS_JSON;
    else process.env.TOTEMORA_BARK_TARGETS_JSON = targetsEnvironment;
  }
}

async function scenario(
  id: string,
  operation: () => Promise<Record<string, unknown>>,
): Promise<StabilityDrillScenario> {
  const started = performance.now();
  try {
    const evidence = await operation();
    return { id, status: "passed", duration_ms: Math.round(performance.now() - started), evidence };
  } catch (error) {
    return {
      id,
      status: "failed",
      duration_ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}

function renderMarkdown(report: StabilityDrillReport): string {
  const rows = report.scenarios.map((item) =>
    `| ${item.id} | ${item.status} | ${item.duration_ms} | ${item.error ?? JSON.stringify(item.evidence)} |`).join("\n");
  return `# Totemora stability drill\n\n- Created: ${report.created_at}\n- Passed: ${report.summary.passed}/${report.summary.attempted}\n\n| Scenario | Status | Duration (ms) | Evidence |\n| --- | --- | ---: | --- |\n${rows}\n`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  const output = await runStabilityDrills({
    dataDir: optionValue(process.argv.slice(2), "--data-dir") ?? resolve(import.meta.dir, "../.totemora"),
    configDir: optionValue(process.argv.slice(2), "--config-dir"),
  });
  console.log(`Stability drill: ${output.report.summary.passed}/${output.report.summary.attempted} passed`);
  console.log(`JSON: ${output.jsonPath}`);
  console.log(`Report: ${output.markdownPath}`);
  if (output.report.summary.failed) process.exitCode = 1;
}
