import { isAbsolute, resolve } from "node:path";

import { shanghaiClock } from "./domains/reminder/reminder";
import { importLegacyMemoSnapshot } from "./integrations/legacy-memo-importer";
import { ReminderRepository } from "./repositories/reminder-repository";

type ReminderCliCommand =
  | { command: "list"; dataDir: string; status: "active" | "completed" | "expired" | "all" }
  | { command: "add"; dataDir: string; title: string; deadline: string; importance: number }
  | { command: "complete" | "reopen"; dataDir: string; id: string }
  | {
    command: "import-legacy";
    dataDir: string;
    source: string;
    sourceRef: string;
    localDate: string;
    apply: boolean;
  };

const root = resolve(import.meta.dir, "../../..");

export function parseReminderCliArgs(args: string[]): ReminderCliCommand {
  const command = args[0];
  const options = parseOptions(args.slice(1));
  const dataDir = options.get("data-dir") ?? resolve(root, ".totemora");
  if (command === "list") {
    const status = options.get("status") ?? "active";
    if (!["active", "completed", "expired", "all"].includes(status)) fail("--status is invalid");
    return { command, dataDir, status: status as "active" | "completed" | "expired" | "all" };
  }
  if (command === "add") {
    return {
      command,
      dataDir,
      title: required(options, "title"),
      deadline: required(options, "deadline"),
      importance: Number(required(options, "importance")),
    };
  }
  if (command === "complete" || command === "reopen") {
    return { command, dataDir, id: required(options, "id") };
  }
  if (command === "import-legacy") {
    const source = required(options, "source");
    if (!isAbsolute(source)) fail("--source must be an absolute snapshot path");
    return {
      command,
      dataDir,
      source,
      sourceRef: options.get("source-ref") ?? "notice-ntfy:memo:d75fa2d",
      localDate: options.get("local-date") ?? shanghaiClock().local_date,
      apply: options.get("apply") === "true",
    };
  }
  fail("Usage: reminder <list|add|complete|reopen|import-legacy> [options]");
}

export async function runReminderCli(command: ReminderCliCommand): Promise<unknown> {
  if (command.command === "import-legacy") {
    return importLegacyMemoSnapshot({
      sourcePath: command.source,
      sourceRef: command.sourceRef,
      localDate: command.localDate,
      dataDir: command.dataDir,
      apply: command.apply,
    });
  }
  const repository = new ReminderRepository(command.dataDir);
  if (command.command === "list") return { reminders: repository.list(command.status) };
  if (command.command === "add") return { reminder: repository.create({
    title: command.title,
    deadline_local_date: command.deadline,
    importance: command.importance,
  }) };
  return {
    reminder: command.command === "complete"
      ? repository.complete(command.id)
      : repository.reopen(command.id),
  };
}

function parseOptions(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "apply") {
      result.set(key, "true");
      continue;
    }
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

function fail(message: string): never {
  throw new Error(message);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runReminderCli(parseReminderCliArgs(Bun.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
