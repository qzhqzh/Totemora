import { resolve } from "node:path";

import { createNotifierApp } from "./app";
import { loadNotificationIngressConfig } from "./bootstrap/notification-ingress-config";
import { loadNotificationRuntimeTargets } from "./bootstrap/notification-runtime-config";

const dataDir = resolve(process.env.NOTIFIER_DATA_DIR ?? "/data");
const config = await loadNotificationIngressConfig({ dataDir, filePath: process.env.NOTIFIER_CONFIG_FILE });
if (!config.operator_token) throw new Error("Notifier requires operator_token in its private config");
const targets = await loadNotificationRuntimeTargets({ dataDir, filePath: process.env.NOTIFIER_TARGETS_FILE });
const app = await createNotifierApp({ dataDir, config, targets, operatorToken: config.operator_token });
const port = Number(process.env.NOTIFIER_PORT ?? 4321);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("NOTIFIER_PORT must be 1-65535");
const server = Bun.serve({
  hostname: process.env.NOTIFIER_HOST ?? "127.0.0.1", port, fetch: app.fetch,
});

let working = false;
const timer = setInterval(async () => {
  if (working) return;
  working = true;
  try { await app.runDue(); } catch (error) {
    console.error("Notifier delivery worker failed:", error instanceof Error ? error.message : "unknown error");
  } finally { working = false; }
}, 10_000);
timer.unref();
console.log(`Notifier listening on ${server.hostname}:${server.port}`);
