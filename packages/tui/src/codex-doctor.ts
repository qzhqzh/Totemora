import type { ParsedCliArguments } from "./cli-arguments";
import type { CliStreams } from "./commands";
import type { GatewayFetch } from "./gateway-request";
import { requestGatewayJson } from "./gateway-request";
import { readOperatorToken } from "./operator-token";

const SUPPORTED_CODEX_VERSION = "0.150.1";

interface CodexDoctorStatus {
  enabled: boolean;
  connected: boolean;
  socket_path: string;
  cli_version?: string;
  last_scan_at?: string;
  next_scan_at?: string;
  observed_threads: number;
  running_threads?: number;
  managed_threads: number;
  active_managed_threads: number;
  open_interactions: number;
  directive_counts?: { uncertain?: number; failed?: number };
  last_error?: string;
}

export async function runCodexDoctor(
  parsed: ParsedCliArguments,
  streams: CliStreams,
  request: GatewayFetch,
): Promise<number> {
  const token = process.env.TOTEMORA_OPERATOR_TOKEN ?? readOperatorToken(parsed.dataDir);
  if (!token) throw new Error("Codex doctor requires TOTEMORA_OPERATOR_TOKEN or <data-dir>/operator-token");
  const status = await requestGatewayJson<CodexDoctorStatus>(request, new URL("/api/codex/status", parsed.gatewayUrl).toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  const compatible = !status.cli_version || status.cli_version.includes(SUPPORTED_CODEX_VERSION);
  const uncertainDirectives = status.directive_counts?.uncertain ?? 0;
  const failedDirectives = status.directive_counts?.failed ?? 0;
  streams.stdout.write("Codex supervisor doctor\n");
  streams.stdout.write(`- feature: ${status.enabled ? "enabled" : "disabled"}\n`);
  streams.stdout.write(`- shared App Server: ${status.connected ? "connected" : "disconnected"}\n`);
  streams.stdout.write(`- socket: ${status.socket_path}\n`);
  streams.stdout.write(`- Codex version: ${status.cli_version ?? "not reported"} (validated contract ${SUPPORTED_CODEX_VERSION})\n`);
  streams.stdout.write(`- scan: ${status.last_scan_at ?? "never"}; next=${status.next_scan_at ?? "unscheduled"}\n`);
  streams.stdout.write(`- tasks: observed=${status.observed_threads} codex_running=${status.running_threads ?? "unknown"} managed=${status.managed_threads} managed_active=${status.active_managed_threads}\n`);
  streams.stdout.write(`- directives: uncertain=${uncertainDirectives} failed=${failedDirectives}\n`);
  streams.stdout.write(`- interactions: open=${status.open_interactions}\n`);
  if (uncertainDirectives > 0) {
    streams.stderr.write(`- operator review required: ${uncertainDirectives} directive delivery result(s) are uncertain\n`);
  }
  if (status.last_error) streams.stderr.write(`- runtime error: ${status.last_error}\n`);
  if (!status.cli_version) streams.stderr.write("- warning: App Server did not report its version; protocol contract could not be confirmed\n");
  if (!compatible) streams.stderr.write(`- incompatible: expected Codex ${SUPPORTED_CODEX_VERSION}\n`);
  return status.enabled && status.connected && Boolean(status.last_scan_at)
    && compatible && !status.last_error && uncertainDirectives === 0 ? 0 : 1;
}
