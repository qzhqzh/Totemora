import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";

import type { LocalConfigSet } from "@totemora/core";

import { ConfiguredProviderRegistry } from "./registry";

test("loads Anthropic-compatible credentials from a Claude settings file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "totemora-settings-"));
  const settingsFile = join(dir, "settings.json");
  await writeFile(
    settingsFile,
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "local-token",
        ANTHROPIC_BASE_URL: "https://example.test/anthropic",
      },
    }),
  );

  try {
    const registry = new ConfiguredProviderRegistry(
      createConfig(settingsFile),
      {},
    );
    expect(registry.get("xiaomi")).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function createConfig(settingsFile: string): LocalConfigSet {
  return {
    providers: {
      providers: {
        xiaomi: {
          type: "anthropic_compatible",
          settings_file: settingsFile,
        },
      },
    },
    agents: { agents: [] },
    roles: { roles: {} },
    tribe: {
      tribe: {
        id: "test",
        name: "test",
        election: { strategy: "weighted_score", required_roles: [] },
        council: { proposal_count: 1, chief_must_choose_one: true },
        execution: { max_retry_before_help: 1, help_targets: [] },
        review: { required: false, reviewer: "chief" },
        manual: { allow_agent_proposals: false, auto_apply: false },
      },
    },
  };
}
