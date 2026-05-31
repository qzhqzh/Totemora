import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";

import { runCli } from "./commands";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lists configured providers", async () => {
  const output = createOutput();

  const exitCode = await runCli(
    ["providers", "list", "--config-dir", "configs/example"],
    output,
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("Providers");
  expect(output.stdoutText()).toContain("openai");
  expect(output.stdoutText()).toContain("qwen");
});

test("lists configured agents with roles and tools", async () => {
  const output = createOutput();

  const exitCode = await runCli(
    ["agents", "list", "--config-dir", "configs/example"],
    output,
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("gpt_strategist");
  expect(output.stdoutText()).toContain("roles=chief,shaman,reviewer");
  expect(output.stdoutText()).toContain("tools=file_read,web_search,code_review");
});

test("inspects configured tribe", async () => {
  const output = createOutput();

  const exitCode = await runCli(
    ["tribe", "inspect", "--config-dir", "configs/example"],
    output,
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("Tribe: default");
  expect(output.stdoutText()).toContain("Required roles: chief,shaman,warrior");
  expect(output.stdoutText()).toContain("Manual auto apply: false");
});

test("returns non-zero with clear output for invalid config", async () => {
  const configDir = await createInvalidConfigDir();
  const output = createOutput();

  const exitCode = await runCli(
    ["providers", "list", "--config-dir", configDir],
    output,
  );

  expect(exitCode).toBe(1);
  expect(output.stderrText()).toContain("Config validation failed");
  expect(output.stderrText()).toContain("agents.yaml");
  expect(output.stderrText()).toContain("Unknown provider reference");
});

function createOutput(): {
  stdout: { write: (chunk: string) => void };
  stderr: { write: (chunk: string) => void };
  stdoutText: () => string;
  stderrText: () => string;
} {
  const chunks = {
    stdout: [] as string[],
    stderr: [] as string[],
  };

  return {
    stdout: {
      write(chunk: string) {
        chunks.stdout.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        chunks.stderr.push(chunk);
      },
    },
    stdoutText: () => chunks.stdout.join(""),
    stderrText: () => chunks.stderr.join(""),
  };
}

async function createInvalidConfigDir(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "totemora-invalid-config-"));
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
      "  - id: broken_agent",
      "    provider: missing_provider",
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
      "      - chief",
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
