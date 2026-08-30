import { isAbsolute, resolve } from "node:path";

import { FORWARDED_STATUS_VALUES, type ForwardedStatus } from "./domains/forwarded/forwarded-event";
import { importLegacyForwardedSnapshot } from "./integrations/legacy-forwarded-importer";
import { ForwardedRepository } from "./repositories/forwarded-repository";

type ForwardedCliCommand =
  | { command: "list"; dataDir: string; status: ForwardedStatus | "all"; limit: number }
  | { command: "status"; dataDir: string }
  | { command: "import-legacy"; dataDir: string; source: string; sourceRef: string; apply: boolean };
const root = resolve(import.meta.dir, "../../..");

export function parseForwardedCliArgs(args: string[]): ForwardedCliCommand {
  const command = args[0];
  const options = parseOptions(args.slice(1));
  const dataDir = options.get("data-dir") ?? resolve(root, ".totemora");
  if (command === "status") return { command, dataDir };
  if (command === "list") {
    const status = options.get("status") ?? "all";
    if (status !== "all" && !FORWARDED_STATUS_VALUES.includes(status as ForwardedStatus)) fail("--status is invalid");
    const limit = Number(options.get("limit") ?? "50");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("--limit must be 1-100");
    return { command, dataDir, status: status as ForwardedStatus | "all", limit };
  }
  if (command === "import-legacy") {
    const source = required(options, "source");
    if (!isAbsolute(source)) fail("--source must be an absolute snapshot path");
    return {
      command, dataDir, source,
      sourceRef: options.get("source-ref") ?? "notice-ntfy:forwarded:d75fa2d",
      apply: options.get("apply") === "true",
    };
  }
  fail("Usage: forwarded <list|status|import-legacy> [options]");
}

export async function runForwardedCli(command: ForwardedCliCommand): Promise<unknown> {
  if (command.command === "import-legacy") return importLegacyForwardedSnapshot({
    sourcePath: command.source, sourceRef: command.sourceRef, dataDir: command.dataDir, apply: command.apply,
  });
  const repository = new ForwardedRepository(command.dataDir);
  return command.command === "status"
    ? repository.summary("legacy-forwarded")
    : { events: repository.list(command.status, command.limit) };
}

function parseOptions(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "apply") { result.set(key, "true"); continue; }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`--${key} requires a value`);
    if (result.has(key)) fail(`--${key} was provided more than once`);
    result.set(key, value);
    index += 1;
  }
  return result;
}
function required(options: Map<string, string>, key: string): string {
  const value = options.get(key)?.trim();
  if (!value) fail(`--${key} is required`);
  return value;
}
function fail(message: string): never { throw new Error(message); }

if (import.meta.main) {
  try { console.log(JSON.stringify(await runForwardedCli(parseForwardedCliArgs(Bun.argv.slice(2))), null, 2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
