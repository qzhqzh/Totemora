import { isAbsolute, resolve } from "node:path";

import type { IntelligenceDomain } from "./intelligence-candidate-store";
import { importLegacyIntelligenceEvidence } from "./integrations/legacy-intelligence-evidence-importer";

interface ImportLegacyCommand {
  command: "import-legacy";
  dataDir: string;
  source: string;
  sourceRef: string;
  domain: IntelligenceDomain;
  historyHours: number;
  apply: boolean;
}

const root = resolve(import.meta.dir, "../../..");

export function parseIntelligenceEvidenceCliArgs(args: string[]): ImportLegacyCommand {
  if (args[0] !== "import-legacy") fail("Usage: intelligence:evidence import-legacy [options]");
  const options = parseOptions(args.slice(1));
  const source = required(options, "source");
  if (!isAbsolute(source)) fail("--source must be an absolute snapshot path");
  const domain = required(options, "domain");
  if (domain !== "ai" && domain !== "finance") fail("--domain must be ai or finance");
  const historyHours = Number(options.get("history-hours") ?? "168");
  if (!Number.isSafeInteger(historyHours) || historyHours < 1 || historyHours > 8_760) {
    fail("--history-hours must be 1-8760");
  }
  return {
    command: "import-legacy",
    dataDir: options.get("data-dir") ?? resolve(root, ".totemora"),
    source,
    sourceRef: options.get("source-ref") ?? `notice-ntfy:${domain}:d75fa2d`,
    domain,
    historyHours,
    apply: options.get("apply") === "true",
  };
}

export async function runIntelligenceEvidenceCli(command: ImportLegacyCommand): Promise<unknown> {
  return importLegacyIntelligenceEvidence({
    domain: command.domain,
    sourcePath: command.source,
    sourceRef: command.sourceRef,
    dataDir: command.dataDir,
    historyHours: command.historyHours,
    apply: command.apply,
  });
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
  try {
    console.log(JSON.stringify(await runIntelligenceEvidenceCli(parseIntelligenceEvidenceCliArgs(Bun.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
