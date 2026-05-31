import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

import type {
  AgentsConfig,
  LocalConfigSet,
  ProvidersConfig,
  RolesConfig,
  TribeConfigFile,
} from "./types";

export const CONFIG_FILE_NAMES = {
  providers: "providers.yaml",
  agents: "agents.yaml",
  roles: "roles.yaml",
  tribe: "tribe.yaml",
} as const;

export interface LoadConfigOptions {
  configDir?: string;
  cwd?: string;
}

export class ConfigLoadError extends Error {
  readonly filePath: string;

  constructor(message: string, filePath: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ConfigLoadError";
    this.filePath = filePath;
  }
}

export function resolveConfigDir(options: LoadConfigOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const configDir =
    options.configDir ?? process.env.TOTEMORA_CONFIG_DIR ?? "configs";

  return resolve(cwd, configDir);
}

export async function loadLocalConfig(
  options: LoadConfigOptions = {},
): Promise<LocalConfigSet> {
  const configDir = resolveConfigDir(options);

  const [providers, agents, roles, tribe] = await Promise.all([
    readYamlFile<ProvidersConfig>(configDir, CONFIG_FILE_NAMES.providers),
    readYamlFile<AgentsConfig>(configDir, CONFIG_FILE_NAMES.agents),
    readYamlFile<RolesConfig>(configDir, CONFIG_FILE_NAMES.roles),
    readYamlFile<TribeConfigFile>(configDir, CONFIG_FILE_NAMES.tribe),
  ]);

  return {
    providers,
    agents,
    roles,
    tribe,
  };
}

async function readYamlFile<T>(configDir: string, fileName: string): Promise<T> {
  const filePath = resolve(configDir, fileName);

  try {
    const content = await readFile(filePath, "utf8");
    return parse(content) as T;
  } catch (error) {
    throw new ConfigLoadError(
      `Failed to load config file: ${fileName}`,
      filePath,
      error,
    );
  }
}
