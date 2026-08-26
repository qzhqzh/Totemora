import {
  ConfigLoadError,
  ConfigValidationError,
  FileRunStore,
  TribeRuntime,
  collectWorkspaceSnapshot,
  type ProviderRegistry,
  loadLocalConfig,
  validateLocalConfig,
} from "@totemora/core";
import { ConfiguredProviderRegistry } from "@totemora/providers";
import { resolve } from "node:path";
import { runBenchmark } from "./benchmark";
import { parseCliArguments } from "./cli-arguments";
import { runDevelopmentGatewayCommand } from "./development-gateway-command";
import { runGatewayTask } from "./gateway-run-command";
import type { GatewayFetch } from "./gateway-request";
import { readOperatorToken } from "./operator-token";
import { writeTaskReport, writeUsage } from "./run-output";

export interface CliStreams {
  stdout: WritableTextStream;
  stderr: WritableTextStream;
}

export interface WritableTextStream {
  write(chunk: string): boolean | void;
}

export interface CliDependencies {
  createProviderRegistry?: (
    config: Awaited<ReturnType<typeof loadLocalConfig>>,
  ) => ProviderRegistry;
  fetch?: GatewayFetch;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function runCli(
  args: string[],
  streams: CliStreams,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    const parsed = parseCliArguments(args);

    if (parsed.help || parsed.command.length === 0) {
      writeHelp(streams.stdout);
      return 0;
    }

    const [resource, action] = parsed.command;

    if (resource === "development") {
      return runDevelopmentGatewayCommand(parsed, streams.stdout, dependencies.fetch ?? fetch);
    }

    if (resource === "run" && action !== "onboarding-exam" && !parsed.offline) {
      const goal = parsed.command.slice(1).join(" ").trim();
      if (!goal) throw new Error('Usage: totemora run "<goal>" [--workspace <path>]');
      if (parsed.configDir) throw new Error("--config-dir is only valid for --offline Run commands");
      const token = process.env.TOTEMORA_OPERATOR_TOKEN ?? readOperatorToken(parsed.dataDir);
      if (!token) {
        throw new Error("Gateway Run requires TOTEMORA_OPERATOR_TOKEN or <data-dir>/operator-token");
      }
      return runGatewayTask({
        gatewayUrl: parsed.gatewayUrl,
        operatorToken: token,
        goal,
        workspace: parsed.workspace ?? (!parsed.workplace && !parsed.mission ? process.cwd() : undefined),
        workplaceId: parsed.workplace,
        missionId: parsed.mission,
        acceptance: parsed.acceptance.length > 0 ? parsed.acceptance : defaultAcceptanceCriteria(),
        chief: parsed.chief,
        maxFiles: parsed.maxFiles,
        maxContextBytes: parsed.maxContextBytes,
        maxOutputTokens: parsed.maxOutputTokens,
        maxMembers: parsed.maxMembers,
        maxTotalTokens: parsed.maxTotalTokens,
      }, streams.stdout, dependencies.fetch ?? fetch, dependencies.wait);
    }

    if (resource === "run" && action === "onboarding-exam" && !parsed.offline) {
      throw new Error("onboarding-exam is a local compatibility command; add --offline");
    }

    const config = await loadLocalConfig({ configDir: parsed.configDir });
    validateLocalConfig(config);

    if (resource === "providers" && action === "list") {
      writeProviders(config, streams.stdout);
      return 0;
    }

    if (resource === "agents" && action === "list") {
      writeAgents(config, streams.stdout);
      return 0;
    }

    if (resource === "tribe" && action === "inspect") {
      writeTribe(config, streams.stdout);
      return 0;
    }

    if (resource === "providers" && action === "doctor") {
      return doctorProviders(
        config,
        createRegistry(config, dependencies),
        streams,
      );
    }

    if (resource === "benchmark" && action === "run") {
      if (!parsed.suite || !parsed.strongMember || !parsed.cheapMember) {
        throw new Error("Usage: totemora benchmark run --suite <path> --strong-member <id> --cheap-member <id>");
      }
      const benchmark = await runBenchmark({
        suitePath: parsed.suite,
        config,
        providers: createRegistry(config, dependencies),
        dataDir: parsed.dataDir ?? resolve(".totemora"),
        strongMemberId: parsed.strongMember,
        cheapMemberId: parsed.cheapMember,
        chiefMemberId: parsed.chief,
        maxFiles: parsed.maxFiles,
        maxContextBytes: parsed.maxContextBytes,
        maxOutputTokens: parsed.maxOutputTokens,
        pricingSnapshotPath: parsed.pricingSnapshot,
      });
      streams.stdout.write(`Benchmark: ${benchmark.result.id}\n`);
      for (const [strategy, summary] of Object.entries(benchmark.result.summary)) {
        streams.stdout.write(
          `- ${strategy}: ${summary.structural_passed}/${summary.attempted} structurally passed, total_tokens=${summary.total_tokens}, strong_tokens=${summary.strong_model_tokens}, known_cost_usd=${summary.known_cost_usd}, pricing_gaps=${summary.pricing_gap_cases}, latency_ms=${summary.latency_ms}, usage_gaps=${summary.usage_unknown_cases}\n`,
        );
      }
      streams.stdout.write(`JSON: ${benchmark.jsonPath}\nReport: ${benchmark.markdownPath}\n`);
      return 0;
    }

    if (resource === "run" && action === "onboarding-exam") {
      const runtime = new TribeRuntime(
        config,
        createRegistry(config, dependencies),
        new FileRunStore(parsed.dataDir),
        undefined,
        createCliObserver(streams.stdout),
      );
      const run = await runtime.runOnboardingExam(parsed.chief);
      writeExam(
        run.final_artifact,
        run.id,
        run.review_outcome,
        run.usage,
        streams.stdout,
      );
      return 0;
    }

    if (resource === "run") {
      const goal = parsed.command.slice(1).join(" ").trim();
      if (!goal) {
        throw new Error('Usage: totemora run "<goal>" [--workspace <path>]');
      }
      const workspace = await collectWorkspaceSnapshot(
        parsed.workspace ?? process.cwd(),
        {
          maxFiles: parsed.maxFiles,
          maxTotalBytes: parsed.maxContextBytes,
        },
      );
      streams.stdout.write(
        `Workspace: ${workspace.files.length} files, ${workspace.total_bytes} bytes, ${workspace.omitted_files} omitted\n`,
      );
      const runtime = new TribeRuntime(
        config,
        createRegistry(config, dependencies),
        new FileRunStore(parsed.dataDir),
        undefined,
        createCliObserver(streams.stdout),
      );
      const run = await runtime.runTask(
        {
          id: `user_task_${crypto.randomUUID()}`,
          goal,
          acceptance:
            parsed.acceptance.length > 0
              ? parsed.acceptance
              : defaultAcceptanceCriteria(),
          workspace,
          constraints: { read_only: true },
          budget: {
            max_context_bytes: parsed.maxContextBytes,
            max_output_tokens_per_call: parsed.maxOutputTokens,
            max_members: parsed.maxMembers,
            max_total_tokens: parsed.maxTotalTokens,
          },
        },
        parsed.chief,
      );
      writeTaskReport(
        run.final_report,
        run.id,
        run.review_outcome,
        run.usage,
        streams.stdout,
      );
      return 0;
    }

    streams.stderr.write(`Unknown command: ${parsed.command.join(" ")}\n`);
    writeHelp(streams.stderr);
    return 1;
  } catch (error) {
    writeCliError(error, streams.stderr);
    return 1;
  }
}

function createCliObserver(stdout: CliStreams["stdout"]) {
  return {
    onProgress(progress: { phase: string; message: string }) {
      stdout.write(`[${progress.phase}] ${progress.message}\n`);
    },
  };
}

function createRegistry(
  config: Awaited<ReturnType<typeof loadLocalConfig>>,
  dependencies: CliDependencies,
): ProviderRegistry {
  return dependencies.createProviderRegistry?.(config) ??
    new ConfiguredProviderRegistry(config);
}

async function doctorProviders(
  config: Awaited<ReturnType<typeof loadLocalConfig>>,
  registry: ProviderRegistry,
  streams: CliStreams,
): Promise<number> {
  streams.stdout.write("Provider readiness\n");
  let hasFailure = false;

  for (const providerId of Object.keys(config.providers.providers)) {
    const member = config.agents.agents.find(
      (candidate) =>
        candidate.provider === providerId &&
        candidate.status !== "inactive" &&
        candidate.status !== "retired",
    );
    if (!member) {
      streams.stdout.write(`- ${providerId}: skipped (no active member)\n`);
      continue;
    }
    try {
      const response = await registry.get(providerId).generate({
        memberId: member.id,
        model: member.model,
        messages: [{ role: "user", content: "只回复 READY" }],
        maxTokens: 256,
      });
      streams.stdout.write(
        `- ${providerId}: ready member=${member.id} model=${member.model} tokens=${response.usage?.totalTokens ?? "unknown"}\n`,
      );
    } catch (error) {
      hasFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      streams.stderr.write(`- ${providerId}: failed (${message})\n`);
    }
  }

  return hasFailure ? 1 : 0;
}

function writeProviders(
  config: Awaited<ReturnType<typeof loadLocalConfig>>,
  stdout: CliStreams["stdout"],
): void {
  stdout.write("Providers\n");

  for (const [id, provider] of Object.entries(config.providers.providers)) {
    const source = provider.settings_file
      ? `settings=${provider.settings_file}`
      : `base_url=${provider.base_url}`;
    stdout.write(`- ${id}: ${provider.type} ${source}\n`);
  }
}

function writeAgents(
  config: Awaited<ReturnType<typeof loadLocalConfig>>,
  stdout: CliStreams["stdout"],
): void {
  stdout.write("Agents\n");

  for (const agent of config.agents.agents) {
    stdout.write(
      `- ${agent.id}: provider=${agent.provider} model=${agent.model} roles=${agent.eligible_roles.join(",")} tools=${agent.tools.join(",")}\n`,
    );
  }
}

function writeTribe(
  config: Awaited<ReturnType<typeof loadLocalConfig>>,
  stdout: CliStreams["stdout"],
): void {
  const tribe = config.tribe.tribe;

  stdout.write(`Tribe: ${tribe.id} (${tribe.name})\n`);
  stdout.write(`Chief: ${tribe.chief ?? "auto"}\n`);
  stdout.write(`Election: ${tribe.election.strategy}\n`);
  stdout.write(`Required roles: ${tribe.election.required_roles.join(",")}\n`);
  stdout.write(`Help targets: ${tribe.execution.help_targets.join(",")}\n`);
  stdout.write(`Reviewer: ${tribe.review.reviewer}\n`);
  stdout.write(`Manual auto apply: ${String(tribe.manual.auto_apply)}\n`);
}

function writeExam(
  exam: {
    title: string;
    instructions: string;
    questions: Array<{
      id: number;
      prompt: string;
      answer: string;
      rationale: string;
      author_member_id: string;
    }>;
  } | undefined,
  runId: string,
  outcome: string | undefined,
  usage: { calls: number; total_tokens: number } | undefined,
  stdout: CliStreams["stdout"],
): void {
  if (!exam) {
    throw new Error("Completed run has no exam artifact");
  }
  stdout.write(`${exam.title}\n${exam.instructions}\n\n`);
  for (const question of exam.questions) {
    stdout.write(`${question.id}. ${question.prompt}\n`);
    stdout.write(`   参考答案：${question.answer}\n`);
    stdout.write(`   考察理由：${question.rationale}\n`);
    stdout.write(`   贡献成员：${question.author_member_id}\n`);
  }
  stdout.write(`\nRun: ${runId}\n`);
  stdout.write(`Outcome: ${outcome ?? "unknown"}\n`);
  writeUsage(usage, stdout);
}

function defaultAcceptanceCriteria(): string[] {
  return [
    "直接回答用户目标，不扩展到无关任务",
    "关键事实引用 Workspace 中的真实相对路径",
    "明确区分文件证据、推断与不确定项",
    "保持只读，不声称执行命令或修改文件",
  ];
}

function writeHelp(stdout: CliStreams["stdout"]): void {
  stdout.write(
    [
      "Usage:",
      "  totemora providers list [--config-dir <path>]",
      "  totemora providers doctor [--config-dir <path>]",
      "  totemora agents list [--config-dir <path>]",
      "  totemora tribe inspect [--config-dir <path>]",
      '  totemora development prepare --workplace <id> --goal "<text>" [--gateway-url <url>]',
      "  totemora development approve <proposal_id> [--gateway-url <url>]",
      "  totemora benchmark run --suite <path> --strong-member <id> --cheap-member <id> [--chief <id>] [--pricing-snapshot <path>] [--data-dir <path>]",
      "  totemora run onboarding-exam --offline [--chief <member_id>] [--config-dir <path>] [--data-dir <path>]",
      '  totemora run "<goal>" [--workspace <path> | --workplace <id> | --mission <id>] [--gateway-url <url>] [--data-dir <path>]',
      '  totemora run "<goal>" --offline [--workspace <path>] [--accept <criterion>] [--chief <member_id>] [--config-dir <path>] [--data-dir <path>]',
      "    Optional budgets: --max-files <n> --max-context-bytes <n> --max-output-tokens <n> --max-members <n> --max-total-tokens <n>",
      "",
    ].join("\n"),
  );
}

function writeCliError(error: unknown, stderr: CliStreams["stderr"]): void {
  if (error instanceof ConfigLoadError) {
    stderr.write(`${error.message}\n`);
    stderr.write(`File: ${error.filePath}\n`);
    return;
  }

  if (error instanceof ConfigValidationError) {
    stderr.write(`${error.message}\n`);
    return;
  }

  stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
}
