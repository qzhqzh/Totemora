import {
  ConfigLoadError,
  ConfigValidationError,
  FileRunStore,
  TribeRuntime,
  collectWorkspaceSnapshot,
  type TaskReport,
  type ProviderRegistry,
  loadLocalConfig,
  validateLocalConfig,
} from "@totemora/core";
import { ConfiguredProviderRegistry } from "@totemora/providers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
}

type GatewayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function runCli(
  args: string[],
  streams: CliStreams,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    const parsed = parseArgs(args);

    if (parsed.help || parsed.command.length === 0) {
      writeHelp(streams.stdout);
      return 0;
    }

    if (parsed.command[0] === "development") {
      return runDevelopmentGatewayCommand(parsed, streams, dependencies.fetch ?? fetch);
    }

    const config = await loadLocalConfig({ configDir: parsed.configDir });
    validateLocalConfig(config);

    const [resource, action] = parsed.command;

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

function parseArgs(args: string[]): {
  command: string[];
  configDir?: string;
  dataDir?: string;
  chief?: string;
  workspace?: string;
  acceptance: string[];
  maxFiles?: number;
  maxContextBytes?: number;
  maxOutputTokens?: number;
  gatewayUrl: string;
  workplace?: string;
  goal?: string;
  help: boolean;
} {
  const command: string[] = [];
  let configDir: string | undefined;
  let dataDir: string | undefined;
  let chief: string | undefined;
  let workspace: string | undefined;
  const acceptance: string[] = [];
  let maxFiles: number | undefined;
  let maxContextBytes: number | undefined;
  let maxOutputTokens: number | undefined;
  let gatewayUrl = process.env.TOTEMORA_GATEWAY_URL ?? "http://127.0.0.1:4310";
  let workplace: string | undefined;
  let goal: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--config-dir") {
      configDir = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--data-dir") {
      dataDir = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--chief") {
      chief = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--workspace") {
      workspace = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--accept") {
      acceptance.push(requireOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--max-files") {
      maxFiles = parsePositiveInteger(requireOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === "--max-context-bytes") {
      maxContextBytes = parsePositiveInteger(
        requireOptionValue(args, index, arg),
        arg,
      );
      index += 1;
      continue;
    }

    if (arg === "--max-output-tokens") {
      maxOutputTokens = parsePositiveInteger(
        requireOptionValue(args, index, arg),
        arg,
      );
      index += 1;
      continue;
    }

    if (arg === "--gateway-url") {
      gatewayUrl = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--workplace") {
      workplace = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--goal") {
      goal = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    command.push(arg);
  }

  return {
    command,
    configDir,
    dataDir,
    chief,
    workspace,
    acceptance,
    maxFiles,
    maxContextBytes,
    maxOutputTokens,
    gatewayUrl,
    workplace,
    goal,
    help,
  };
}

async function runDevelopmentGatewayCommand(
  parsed: ReturnType<typeof parseArgs>,
  streams: CliStreams,
  request: GatewayFetch,
): Promise<number> {
  const action = parsed.command[1];
  const token = process.env.TOTEMORA_OPERATOR_TOKEN ?? readOperatorToken(parsed.dataDir);
  if (!token) throw new Error("TOTEMORA_OPERATOR_TOKEN is required for development commands");
  let path: string;
  let body: unknown;
  if (action === "prepare") {
    if (!parsed.workplace || !parsed.goal) {
      throw new Error("Usage: totemora development prepare --workplace <id> --goal <text>");
    }
    path = "/api/development/prepare";
    body = { workplace_id: parsed.workplace, goal: parsed.goal };
  } else if (action === "approve") {
    const proposalId = parsed.command[2];
    if (!proposalId) throw new Error("Usage: totemora development approve <proposal_id>");
    path = `/api/development/proposals/${encodeURIComponent(proposalId)}/approve`;
  } else {
    throw new Error("Usage: totemora development <prepare|approve>");
  }
  const response = await request(`${parsed.gatewayUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as {
    id?: string; status?: string; summary?: string; commit_message?: string;
    files?: string[]; review?: { outcome?: string }; commit_sha?: string; error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? `Gateway request failed (${response.status})`);
  streams.stdout.write(`Proposal: ${payload.id}\nStatus: ${payload.status}\n`);
  if (payload.summary) streams.stdout.write(`Summary: ${payload.summary}\n`);
  if (payload.commit_message) streams.stdout.write(`Commit: ${payload.commit_message}\n`);
  if (payload.files) streams.stdout.write(`Files: ${payload.files.join(", ")}\n`);
  if (payload.review) streams.stdout.write(`Review: ${payload.review.outcome}\n`);
  if (payload.commit_sha) streams.stdout.write(`SHA: ${payload.commit_sha}\n`);
  return payload.status === "failed" ? 1 : 0;
}

function readOperatorToken(dataDir?: string): string | undefined {
  try {
    return readFileSync(resolve(dataDir ?? ".totemora", "operator-token"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
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

function writeTaskReport(
  report: TaskReport | undefined,
  runId: string,
  outcome: string | undefined,
  usage: { calls: number; total_tokens: number } | undefined,
  stdout: CliStreams["stdout"],
): void {
  if (!report) {
    throw new Error("Completed run has no task report");
  }
  stdout.write(`\n# ${report.title}\n\n${report.summary}\n\n`);
  stdout.write("## Findings\n");
  for (const finding of report.findings) {
    stdout.write(`- ${finding.claim}\n`);
    for (const evidence of finding.evidence) {
      stdout.write(`  - Evidence: ${evidence}\n`);
    }
  }
  stdout.write("\n## Recommendations\n");
  if (report.recommendations.length === 0) {
    stdout.write("- None\n");
  }
  for (const recommendation of report.recommendations) {
    stdout.write(
      `- [${recommendation.priority}] ${recommendation.action}: ${recommendation.reason}\n`,
    );
  }
  stdout.write("\n## Acceptance\n");
  for (const item of report.acceptance_review) {
    stdout.write(`- [${item.status}] ${item.criterion}: ${item.evidence}\n`);
  }
  stdout.write(`\nRun: ${runId}\n`);
  stdout.write(`Outcome: ${outcome ?? "unknown"}\n`);
  writeUsage(usage, stdout);
}

function writeUsage(
  usage: { calls: number; total_tokens: number } | undefined,
  stdout: CliStreams["stdout"],
): void {
  if (usage) {
    stdout.write(`Usage: ${usage.total_tokens} tokens across ${usage.calls} calls\n`);
  }
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
      "  totemora run onboarding-exam [--chief <member_id>] [--config-dir <path>] [--data-dir <path>]",
      '  totemora run "<goal>" [--workspace <path>] [--accept <criterion>] [--chief <member_id>] [--config-dir <path>] [--data-dir <path>]',
      "    Optional budgets: --max-files <n> --max-context-bytes <n> --max-output-tokens <n>",
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
