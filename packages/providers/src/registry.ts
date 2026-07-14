import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type {
  AgentProvider,
  LocalConfigSet,
  ProviderRegistry,
} from "@totemora/core";

import { AnthropicCompatibleProvider } from "./anthropic-compatible";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { OpenAIResponsesProvider } from "./openai-responses";

export class ConfiguredProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  constructor(config: LocalConfigSet, env: NodeJS.ProcessEnv = process.env) {
    for (const [id, provider] of Object.entries(config.providers.providers)) {
      const settings = provider.settings_file
        ? readClaudeSettings(provider.settings_file)
        : undefined;
      const baseUrl = provider.base_url ?? settings?.ANTHROPIC_BASE_URL;
      const apiKey = provider.api_key_env
        ? env[provider.api_key_env] ?? ""
        : settings?.ANTHROPIC_AUTH_TOKEN ?? "";
      if (!baseUrl) {
        throw new Error(`Missing base URL for provider: ${id}`);
      }
      const options = { id, baseUrl, apiKey };
      if (provider.type === "openai_compatible") {
        this.providers.set(id, new OpenAICompatibleProvider(options));
        continue;
      }
      if (provider.type === "openai_responses") {
        this.providers.set(id, new OpenAIResponsesProvider(options));
        continue;
      }
      if (provider.type === "anthropic_compatible") {
        this.providers.set(id, new AnthropicCompatibleProvider(options));
        continue;
      }
      throw new Error(`Unsupported provider type: ${provider.type}`);
    }
  }

  get(providerId: string): AgentProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return provider;
  }
}

interface ClaudeSettingsEnv {
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
}

function readClaudeSettings(filePath: string): ClaudeSettingsEnv {
  const resolved = filePath.startsWith("~/")
    ? resolve(homedir(), filePath.slice(2))
    : resolve(filePath);
  try {
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as {
      env?: ClaudeSettingsEnv;
    };
    return parsed.env ?? {};
  } catch (error) {
    throw new Error(`Failed to read provider settings file: ${resolved}`, {
      cause: error,
    });
  }
}
