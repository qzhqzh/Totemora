export interface ParsedCliArguments {
  command: string[];
  configDir?: string;
  dataDir?: string;
  chief?: string;
  workspace?: string;
  acceptance: string[];
  maxFiles?: number;
  maxContextBytes?: number;
  maxOutputTokens?: number;
  maxMembers?: number;
  maxTotalTokens?: number;
  gatewayUrl: string;
  workplace?: string;
  mission?: string;
  goal?: string;
  suite?: string;
  strongMember?: string;
  cheapMember?: string;
  pricingSnapshot?: string;
  offline: boolean;
  help: boolean;
}

export function parseCliArguments(args: string[]): ParsedCliArguments {
  const parsed: ParsedCliArguments = {
    command: [], acceptance: [], gatewayUrl: process.env.TOTEMORA_GATEWAY_URL ?? "http://127.0.0.1:4310",
    offline: false, help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") { parsed.help = true; continue; }
    if (arg === "--offline") { parsed.offline = true; continue; }
    if (arg === "--config-dir") { parsed.configDir = option(args, index, arg); index += 1; continue; }
    if (arg === "--data-dir") { parsed.dataDir = option(args, index, arg); index += 1; continue; }
    if (arg === "--chief") { parsed.chief = option(args, index, arg); index += 1; continue; }
    if (arg === "--workspace") { parsed.workspace = option(args, index, arg); index += 1; continue; }
    if (arg === "--accept") { parsed.acceptance.push(option(args, index, arg)); index += 1; continue; }
    if (arg === "--max-files") { parsed.maxFiles = positiveInteger(args, index, arg); index += 1; continue; }
    if (arg === "--max-context-bytes") { parsed.maxContextBytes = positiveInteger(args, index, arg); index += 1; continue; }
    if (arg === "--max-output-tokens") { parsed.maxOutputTokens = positiveInteger(args, index, arg); index += 1; continue; }
    if (arg === "--max-members") { parsed.maxMembers = positiveInteger(args, index, arg); index += 1; continue; }
    if (arg === "--max-total-tokens") { parsed.maxTotalTokens = positiveInteger(args, index, arg); index += 1; continue; }
    if (arg === "--gateway-url") { parsed.gatewayUrl = option(args, index, arg); index += 1; continue; }
    if (arg === "--workplace") { parsed.workplace = option(args, index, arg); index += 1; continue; }
    if (arg === "--mission") { parsed.mission = option(args, index, arg); index += 1; continue; }
    if (arg === "--goal") { parsed.goal = option(args, index, arg); index += 1; continue; }
    if (arg === "--suite") { parsed.suite = option(args, index, arg); index += 1; continue; }
    if (arg === "--strong-member") { parsed.strongMember = option(args, index, arg); index += 1; continue; }
    if (arg === "--cheap-member") { parsed.cheapMember = option(args, index, arg); index += 1; continue; }
    if (arg === "--pricing-snapshot") { parsed.pricingSnapshot = option(args, index, arg); index += 1; continue; }
    parsed.command.push(arg);
  }
  return parsed;
}

function positiveInteger(args: string[], index: number, name: string): number {
  const parsed = Number(option(args, index, name));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function option(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}
