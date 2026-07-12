import { resolve } from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createPlaygroundApp } from "./app";

const root = resolve(import.meta.dir, "../../..");
const webRoot = resolve(root, "packages/web/src");
const dataDir = process.env.TOTEMORA_DATA_DIR ?? resolve(root, ".totemora");
const operatorToken = await loadOrCreateOperatorToken(dataDir);
const app = createPlaygroundApp({
  configDir: process.env.TOTEMORA_CONFIG_DIR ?? resolve(root, "configs/example"),
  dataDir,
  operatorToken,
  projectRoot: root,
});

const server = Bun.serve({
  hostname: process.env.TOTEMORA_HOST ?? "127.0.0.1",
  port: Number(process.env.TOTEMORA_PORT ?? 4310),
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/")) return app.fetch(request);
    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!["index.html", "app.js", "styles.css"].includes(fileName)) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(Bun.file(resolve(webRoot, fileName)), {
      headers: { "Cache-Control": "no-store" },
    });
  },
});

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
