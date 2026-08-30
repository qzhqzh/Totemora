import { isAbsolute, resolve } from "node:path";

import { configureLegacyNtfyTargets } from "./bootstrap/legacy-ntfy-target-config";

const root = resolve(import.meta.dir, "../../..");

if (!import.meta.main) throw new Error("notification-targets-cli must be run as a command");

try {
  const args = new Map<string, string>();
  for (let index = 2; index < Bun.argv.length; index += 2) {
    const key = Bun.argv[index];
    const value = Bun.argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Every notification target option requires a value");
    args.set(key.slice(2), value);
  }
  const credentialsFile = args.get("credentials-file");
  if (!credentialsFile || !isAbsolute(credentialsFile)) {
    throw new Error("--credentials-file must be an absolute path");
  }
  const outputFile = args.get("output-file") ?? resolve(root, ".totemora/secrets/notification-targets.json");
  if (!isAbsolute(outputFile)) throw new Error("--output-file must be an absolute path");
  const report = await configureLegacyNtfyTargets({
    credentialsFile,
    outputFile,
    ...(args.get("server-url") ? { serverUrl: args.get("server-url") } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
