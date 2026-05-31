import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";

import { ConfigLoadError, loadLocalConfig, resolveConfigDir } from "./loader";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }

  delete process.env.TOTEMORA_CONFIG_DIR;
});

test("loads local YAML config files", async () => {
  const configDir = await createConfigDir();

  const config = await loadLocalConfig({ configDir });

  expect(config.providers.providers.openai.type).toBe("openai_compatible");
  expect(config.agents.agents[0]?.id).toBe("gpt_strategist");
  expect(config.roles.roles.chief.max_agents).toBe(1);
  expect(config.tribe.tribe.id).toBe("default");
});

test("resolves config dir from cwd and explicit path", () => {
  const resolved = resolveConfigDir({
    cwd: "/workspace",
    configDir: "configs/example",
  });

  expect(resolved).toBe("/workspace/configs/example");
});

test("uses TOTEMORA_CONFIG_DIR when no explicit config dir is provided", () => {
  process.env.TOTEMORA_CONFIG_DIR = "custom-config";

  const resolved = resolveConfigDir({ cwd: "/workspace" });

  expect(resolved).toBe("/workspace/custom-config");
});

test("throws actionable error for missing config files", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "totemora-config-"));
  tempDirs.push(configDir);

  await expect(loadLocalConfig({ configDir })).rejects.toMatchObject({
    name: "ConfigLoadError",
    message: "Failed to load config file: providers.yaml",
    filePath: join(configDir, "providers.yaml"),
  } satisfies Partial<ConfigLoadError>);
});

async function createConfigDir(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "totemora-config-"));
  tempDirs.push(configDir);
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(configDir, "providers.yaml"),
    [
      "providers:",
      "  openai:",
      "    type: openai_compatible",
      "    base_url: https://api.openai.com/v1",
      "    api_key_env: OPENAI_API_KEY",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(configDir, "agents.yaml"),
    [
      "agents:",
      "  - id: gpt_strategist",
      "    provider: openai",
      "    model: gpt-5",
      "    profile:",
      "      reasoning: 0.95",
      "    eligible_roles:",
      "      - chief",
      "    tools:",
      "      - file_read",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(configDir, "roles.yaml"),
    [
      "roles:",
      "  chief:",
      "    required_capabilities:",
      "      reasoning: 0.35",
      "    max_agents: 1",
      "    permissions:",
      "      - decide_plan",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(configDir, "tribe.yaml"),
    [
      "tribe:",
      "  id: default",
      "  name: Default Tribe",
      "  election:",
      "    strategy: weighted_score",
      "    required_roles:",
      "      - chief",
      "  council:",
      "    proposal_count: 3",
      "    chief_must_choose_one: true",
      "  execution:",
      "    max_retry_before_help: 2",
      "    help_targets:",
      "      - shaman",
      "  review:",
      "    required: true",
      "    reviewer: chief",
      "  manual:",
      "    allow_agent_proposals: true",
      "    auto_apply: false",
      "",
    ].join("\n"),
    "utf8",
  );

  return configDir;
}
