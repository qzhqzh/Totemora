import { expect, test } from "bun:test";

import {
  ConfigValidationError,
  collectConfigValidationIssues,
  validateLocalConfig,
} from "./validation";

import type { LocalConfigSet } from "./types";

test("accepts a valid local config", () => {
  expect(() => validateLocalConfig(createConfig())).not.toThrow();
});

test("reports missing provider references with file and field", () => {
  const config = createConfig();
  config.agents.agents[0].provider = "missing_provider";

  expect(collectConfigValidationIssues(config)).toContainEqual({
    file: "agents.yaml",
    field: "agents.gpt_strategist.provider",
    message: "Unknown provider reference: missing_provider",
  });
});

test("reports missing agent model with file and field", () => {
  const config = createConfig();
  config.agents.agents[0].model = "";

  expect(collectConfigValidationIssues(config)).toContainEqual({
    file: "agents.yaml",
    field: "agents.gpt_strategist.model",
    message: "Agent model is required",
  });
});

test("reports duplicate agent ids with file and field", () => {
  const config = createConfig();
  config.agents.agents.push({
    ...config.agents.agents[0],
    provider: "openai",
  });

  expect(collectConfigValidationIssues(config)).toContainEqual({
    file: "agents.yaml",
    field: "agents.gpt_strategist.id",
    message: "Duplicate agent id: gpt_strategist",
  });
});

test("reports unknown role references with file and field", () => {
  const config = createConfig();
  config.agents.agents[0].eligible_roles = ["unknown_role"];

  expect(collectConfigValidationIssues(config)).toContainEqual({
    file: "agents.yaml",
    field: "agents.gpt_strategist.eligible_roles",
    message: "Unknown role reference: unknown_role",
  });
});

test("reports invalid capability scores with file and field", () => {
  const config = createConfig();
  config.agents.agents[0].profile.reasoning = 1.5;

  expect(collectConfigValidationIssues(config)).toContainEqual({
    file: "agents.yaml",
    field: "agents.gpt_strategist.profile.reasoning",
    message: "Capability score must be between 0 and 1: 1.5",
  });
});

test("reports direct secret values in provider api_key_env", () => {
  const config = createConfig();
  config.providers.providers.openai.api_key_env = "sk-live-secret";

  expect(collectConfigValidationIssues(config)).toContainEqual({
    file: "providers.yaml",
    field: "providers.openai.api_key_env",
    message: "Provider api_key_env must reference an environment variable name",
  });
});

test("throws validation error with aggregated issue details", () => {
  const config = createConfig();
  config.agents.agents[0].provider = "missing_provider";

  expect(() => validateLocalConfig(config)).toThrow(ConfigValidationError);

  try {
    validateLocalConfig(config);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).issues).toHaveLength(1);
    expect((error as Error).message).toContain("agents.yaml");
  }
});

function createConfig(): LocalConfigSet {
  return {
    providers: {
      providers: {
        openai: {
          type: "openai_compatible",
          base_url: "https://api.openai.com/v1",
          api_key_env: "OPENAI_API_KEY",
        },
      },
    },
    agents: {
      agents: [
        {
          id: "gpt_strategist",
          provider: "openai",
          model: "gpt-5",
          profile: {
            reasoning: 0.95,
            review: 0.9,
          },
          eligible_roles: ["chief"],
          tools: ["file_read"],
        },
      ],
    },
    roles: {
      roles: {
        chief: {
          required_capabilities: {
            reasoning: 0.35,
            review: 0.25,
          },
          max_agents: 1,
          permissions: ["decide_plan"],
        },
      },
    },
    tribe: {
      tribe: {
        id: "default",
        name: "Default Tribe",
        election: {
          strategy: "weighted_score",
          required_roles: ["chief"],
        },
        council: {
          proposal_count: 3,
          chief_must_choose_one: true,
        },
        execution: {
          max_retry_before_help: 2,
          help_targets: ["chief"],
        },
        review: {
          required: true,
          reviewer: "chief",
        },
        manual: {
          allow_agent_proposals: true,
          auto_apply: false,
        },
      },
    },
  };
}
