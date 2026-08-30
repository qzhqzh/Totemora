import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const configDir = process.env.TOTEMORA_E2E_CONFIG_DIR;

if (!configDir) {
  throw new Error("TOTEMORA_E2E_CONFIG_DIR is required");
}

await mkdir(configDir, { recursive: true });

const exampleConfigDir = resolve(import.meta.dir, "../../configs/example");
await Promise.all(
  ["agents.yaml", "roles.yaml", "tribe.yaml"].map((fileName) =>
    copyFile(join(exampleConfigDir, fileName), join(configDir, fileName)),
  ),
);

await writeFile(
  join(configDir, "providers.yaml"),
  `providers:
  openai:
    type: openai_responses
    base_url: http://127.0.0.1:9/v1
    api_key_env: TOTEMORA_E2E_API_KEY
  qwen:
    type: anthropic_compatible
    base_url: http://127.0.0.1:9/v1
    api_key_env: TOTEMORA_E2E_API_KEY
  deepseek:
    type: anthropic_compatible
    base_url: http://127.0.0.1:9/v1
    api_key_env: TOTEMORA_E2E_API_KEY
  xiaomi:
    type: anthropic_compatible
    base_url: http://127.0.0.1:9/v1
    api_key_env: TOTEMORA_E2E_API_KEY
  cpa:
    type: openai_compatible
    base_url: http://127.0.0.1:9/v1
    api_key_env: TOTEMORA_E2E_API_KEY
`,
  "utf8",
);

process.env.TOTEMORA_CONFIG_DIR = configDir;
process.env.TOTEMORA_OPERATOR_TOKEN = "totemora-e2e-operator-token";
await import("../../packages/server/src/index");
