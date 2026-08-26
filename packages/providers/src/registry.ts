import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse } from "yaml";

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
  private readonly definitions: LocalConfigSet["providers"]["providers"];

  constructor(config: LocalConfigSet, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.definitions = config.providers.providers;
  }

  get(providerId: string): AgentProvider {
    const existing = this.providers.get(providerId);
    if (existing) return existing;
    const definition = this.definitions[providerId];
    if (!definition) throw new Error(`Unknown provider: ${providerId}`);
    const { baseUrl, apiKey } = resolveProviderConnection(providerId, definition, this.env);
    const options = { id: providerId, baseUrl, apiKey };
    const provider = definition.type === "openai_compatible"
      ? new OpenAICompatibleProvider(options)
      : definition.type === "openai_responses"
        ? new OpenAIResponsesProvider(options)
        : definition.type === "anthropic_compatible"
          ? new AnthropicCompatibleProvider(options)
          : undefined;
    if (!provider) throw new Error(`Unsupported provider type: ${definition.type}`);
    this.providers.set(providerId, provider);
    return provider;
  }
}

interface ProviderSettingsEnv {
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  apiKeys?: string[];
}

export function resolveProviderConnection(
  id: string,
  provider: LocalConfigSet["providers"]["providers"][string],
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; apiKey: string } {
  const settings = provider.settings_file ? readProviderSettings(provider.settings_file) : undefined;
  const baseUrl = provider.base_url ?? settings?.ANTHROPIC_BASE_URL;
  const apiKey = provider.api_key_env
    ? env[provider.api_key_env] ?? ""
    : settings?.ANTHROPIC_AUTH_TOKEN ?? settings?.apiKeys?.[0] ?? "";
  if (!baseUrl) throw new Error(`Missing base URL for provider: ${id}`);
  return { baseUrl, apiKey };
}

function readProviderSettings(filePath: string): ProviderSettingsEnv {
  const resolved = filePath.startsWith("~/")
    ? resolve(homedir(), filePath.slice(2))
    : resolve(filePath);
  try {
    const source = readFileSync(resolved, "utf8");
    if (resolved.endsWith(".yaml") || resolved.endsWith(".yml")) {
      const parsed = parse(source) as { "api-keys"?: unknown };
      const apiKeys = Array.isArray(parsed?.["api-keys"])
        ? parsed["api-keys"].filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      return { apiKeys };
    }
    const parsed = JSON.parse(source) as { env?: ProviderSettingsEnv };
    return parsed.env ?? {};
  } catch (error) {
    throw new Error(`Failed to read provider settings file: ${resolved}`, {
      cause: error,
    });
  }
}
