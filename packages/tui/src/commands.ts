import {
  ConfigLoadError,
  ConfigValidationError,
  loadLocalConfig,
  validateLocalConfig,
} from "@totemora/core";

export interface CliStreams {
  stdout: WritableTextStream;
  stderr: WritableTextStream;
}

export interface WritableTextStream {
  write(chunk: string): boolean | void;
}

export async function runCli(
  args: string[],
  streams: CliStreams,
): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.help || parsed.command.length === 0) {
    writeHelp(streams.stdout);
    return 0;
  }

  try {
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

    streams.stderr.write(`Unknown command: ${parsed.command.join(" ")}\n`);
    writeHelp(streams.stderr);
    return 1;
  } catch (error) {
    writeCliError(error, streams.stderr);
    return 1;
  }
}

function parseArgs(args: string[]): {
  command: string[];
  configDir?: string;
  help: boolean;
} {
  const command: string[] = [];
  let configDir: string | undefined;
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

    command.push(arg);
  }

  return { command, configDir, help };
}

function writeProviders(
  config: Awaited<ReturnType<typeof loadLocalConfig>>,
  stdout: CliStreams["stdout"],
): void {
  stdout.write("Providers\n");

  for (const [id, provider] of Object.entries(config.providers.providers)) {
    stdout.write(`- ${id}: ${provider.type} ${provider.base_url}\n`);
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
  stdout.write(`Election: ${tribe.election.strategy}\n`);
  stdout.write(`Required roles: ${tribe.election.required_roles.join(",")}\n`);
  stdout.write(`Help targets: ${tribe.execution.help_targets.join(",")}\n`);
  stdout.write(`Reviewer: ${tribe.review.reviewer}\n`);
  stdout.write(`Manual auto apply: ${String(tribe.manual.auto_apply)}\n`);
}

function writeHelp(stdout: CliStreams["stdout"]): void {
  stdout.write(
    [
      "Usage:",
      "  totemora providers list [--config-dir <path>]",
      "  totemora agents list [--config-dir <path>]",
      "  totemora tribe inspect [--config-dir <path>]",
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
