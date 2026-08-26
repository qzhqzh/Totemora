import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentConfig, LocalConfigSet } from "@totemora/core";

import { CpaIllustrationService } from "./cpa-illustration-service";
import type { ContentWork, IllustrationBrief } from "./content-studio-service";

test("defers unavailable CPA settings until illustration generation is requested", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-cpa-lazy-"));
  try {
    const referenceDir = join(dataDir, "illustration-references", "user-ip-v1");
    await mkdir(referenceDir, { recursive: true });
    await writeFile(join(referenceDir, "character.png"), "synthetic-anchor");
    const config = createConfig(join(dataDir, "missing-cpa.yaml"));
    const service = new CpaIllustrationService(config, dataDir);

    await expect(service.generate({
      work: createWork(),
      member: createMember(),
      brief: createBrief(),
    })).rejects.toThrow("Failed to read provider settings file");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function createConfig(settingsFile: string): LocalConfigSet {
  return {
    providers: { providers: { cpa: {
      type: "openai_compatible",
      base_url: "http://127.0.0.1:31000/v1",
      settings_file: settingsFile,
    } } },
    agents: { agents: [] },
    roles: { roles: {} },
    tribe: { tribe: {
      id: "test", name: "Test", chief: "chief",
      election: { strategy: "weighted_score", required_roles: [] },
      council: { proposal_count: 1, chief_must_choose_one: true },
      execution: { max_retry_before_help: 1, help_targets: [] },
      review: { required: false, reviewer: "reviewer" },
      manual: { allow_agent_proposals: false, auto_apply: false },
    } },
  };
}

function createMember(): AgentConfig {
  return {
    id: "illustrator", provider: "cpa", model: "image-model",
    profile: {}, eligible_roles: [], tools: [],
  };
}

function createWork(): ContentWork {
  const now = new Date().toISOString();
  return {
    id: "work", format: "x_hot_post", status: "drafting", topic: "test",
    source: { headline: "test", brief: "test", url: "https://example.test/source", provider: "test" },
    chief_member_id: "chief", assignments: [], contributions: [], revision: 1, copy_count: 0,
    usage: { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    created_at: now, updated_at: now,
  };
}

function createBrief(): IllustrationBrief {
  return {
    scene: "test", metaphor: "test", composition: "test", character_action: "test",
    palette: ["black"], alt_text: "test", avoid: ["text"],
  };
}
