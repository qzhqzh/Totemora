import { resolve } from "node:path";
import { homedir } from "node:os";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createCodexAgentMcpHttpHandler,
  createCodexScheduledDeliveryMcpHttpHandler,
  createTotemoraMcpHttpHandler,
} from "@totemora/mcp";
import { createPlaygroundApp } from "./app";
import { CodexSupervisorRunner } from "./application/codex-supervisor-runner";
import { RecurringServiceRunner } from "./recurring-service-runner";
import { RecurringServiceStateRepository } from "./recurring-service-state-repository";
import { resolveWebAsset } from "./web-assets";

const root = resolve(import.meta.dir, "../../..");
const webRoot = resolve(root, "packages/web/src");
const dataDir = process.env.TOTEMORA_DATA_DIR ?? resolve(root, ".totemora");
const operatorToken = await loadOrCreateOperatorToken(dataDir);
const hostname = process.env.TOTEMORA_HOST ?? "127.0.0.1";
const port = Number(process.env.TOTEMORA_PORT ?? 4310);
const codexSupervisorEnabled = ["1", "true"].includes((process.env.TOTEMORA_CODEX_SUPERVISOR_ENABLED ?? "").toLowerCase());
const codexHome = process.env.CODEX_HOME || resolve(homedir(), ".codex");
const codexSocketPath = process.env.TOTEMORA_CODEX_APP_SERVER_SOCKET
  ?? resolve(codexHome, "app-server-control/app-server-control.sock");
const codexSupervisor = new CodexSupervisorRunner({
  dataDir,
  socketPath: codexSocketPath,
  enabled: codexSupervisorEnabled,
  agentMcpUrl: `http://127.0.0.1:${port}/mcp/codex-agent`,
});
let scheduler: RecurringServiceRunner | undefined;
const app = createPlaygroundApp({
  configDir: process.env.TOTEMORA_CONFIG_DIR ?? resolve(root, "configs/example"),
  dataDir,
  operatorToken,
  projectRoot: root,
  recurringServiceStatus: () => scheduler?.status() ?? [],
  codexSupervisor: codexSupervisor.service,
  publicBaseUrl: process.env.TOTEMORA_PUBLIC_BASE_URL,
});
const mcpHandler = createTotemoraMcpHttpHandler({
  gatewayUrl: `http://127.0.0.1:${port}`,
  operatorToken,
});
const codexAgentMcpHandler = createCodexAgentMcpHttpHandler({
  authorize: (token) => codexSupervisor.service.authorizeAgentToken(token),
  raiseInteraction: (token, input) => codexSupervisor.service.raiseAgentInteraction(token, input),
  reportCheckpoint: (token, input) => codexSupervisor.service.reportAgentCheckpoint(token, input),
});
const codexScheduledDeliveryMcpHandler = createCodexScheduledDeliveryMcpHttpHandler({
  authorize: (token) => app.codexScheduledDelivery.authorize(token),
  publish: (token, input) => app.codexScheduledDelivery.publish(token, input),
});

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/") || pathname.startsWith("/r/")) return app.fetch(request);
    if (pathname === "/mcp") return mcpHandler(request);
    if (pathname === "/mcp/codex-agent") return codexAgentMcpHandler(request);
    if (pathname === "/mcp/codex-scheduled") return codexScheduledDeliveryMcpHandler(request);
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    const webAsset = resolveWebAsset(webRoot, pathname);
    if (!webAsset) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(webAsset), {
      headers: { "Cache-Control": "no-store" },
    });
  },
});

scheduler = new RecurringServiceRunner([
  { id: "intelligence.watch", interval_ms: 60_000, run: app.runScheduledIntelligence },
  { id: "finance.watch", interval_ms: 60_000, run: app.runScheduledFinance },
  { id: "content.studio", interval_ms: 60_000, run: app.runScheduledContent },
  { id: "codex.telegram", interval_ms: 60_000, run: app.runScheduledCodexTelegram },
], new RecurringServiceStateRepository(dataDir));
scheduler.start();
codexSupervisor.start();

console.log(`Totemora Web Playground: http://${server.hostname}:${server.port}`);
console.log(`Config: ${process.env.TOTEMORA_CONFIG_DIR ?? "configs/example"}`);
console.log(`Operator token: ${process.env.TOTEMORA_OPERATOR_TOKEN ? "environment" : `${resolve(dataDir, "operator-token")} (0600)`}`);
console.log(`Codex supervisor: ${codexSupervisorEnabled ? `enabled (${codexSocketPath})` : "disabled"}`);

async function loadOrCreateOperatorToken(dataDirectory: string): Promise<string> {
  if (process.env.TOTEMORA_OPERATOR_TOKEN) return process.env.TOTEMORA_OPERATOR_TOKEN;
  const path = resolve(dataDirectory, "operator-token");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dataDirectory, { recursive: true });
  const token = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}
