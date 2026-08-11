import { resolve } from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createTotemoraMcpHttpHandler } from "@totemora/mcp";
import { createPlaygroundApp } from "./app";

const root = resolve(import.meta.dir, "../../..");
const webRoot = resolve(root, "packages/web/src");
const dataDir = process.env.TOTEMORA_DATA_DIR ?? resolve(root, ".totemora");
const operatorToken = await loadOrCreateOperatorToken(dataDir);
const hostname = process.env.TOTEMORA_HOST ?? "127.0.0.1";
const port = Number(process.env.TOTEMORA_PORT ?? 4310);
const app = createPlaygroundApp({
  configDir: process.env.TOTEMORA_CONFIG_DIR ?? resolve(root, "configs/example"),
  dataDir,
  operatorToken,
  projectRoot: root,
});
const mcpHandler = createTotemoraMcpHttpHandler({
  gatewayUrl: `http://127.0.0.1:${port}`,
  operatorToken,
});

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/") || pathname.startsWith("/r/")) return app.fetch(request);
    if (pathname === "/mcp") return mcpHandler(request);
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!["index.html", "app.js", "styles.css"].includes(fileName)) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(Bun.file(resolve(webRoot, fileName)), {
      headers: { "Cache-Control": "no-store" },
    });
  },
});

let scheduledIntelligenceRunning = false;
const intelligenceTimer = setInterval(() => {
  if (scheduledIntelligenceRunning) return;
  scheduledIntelligenceRunning = true;
  void app.runScheduledIntelligence().catch((error) => {
    console.error(`Scheduled intelligence failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    scheduledIntelligenceRunning = false;
  });
}, 60_000);
intelligenceTimer.unref();

let scheduledContentRunning = false;
const contentTimer = setInterval(() => {
  if (scheduledContentRunning) return;
  scheduledContentRunning = true;
  void app.runScheduledContent().catch((error) => {
    console.error(`Scheduled content failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    scheduledContentRunning = false;
  });
}, 60_000);
contentTimer.unref();

console.log(`Totemora Web Playground: http://${server.hostname}:${server.port}`);
console.log(`Config: ${process.env.TOTEMORA_CONFIG_DIR ?? "configs/example"}`);
console.log(`Operator token: ${process.env.TOTEMORA_OPERATOR_TOKEN ? "environment" : `${resolve(dataDir, "operator-token")} (0600)`}`);

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
