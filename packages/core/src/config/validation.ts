import type {
  AgentConfig,
  CapabilityProfile,
  LocalConfigSet,
} from "./types";

export interface ConfigValidationIssue {
  file: string;
  field: string;
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[]) {
    super(formatValidationMessage(issues));
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function validateLocalConfig(config: LocalConfigSet): void {
  const issues = collectConfigValidationIssues(config);

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}

export function collectConfigValidationIssues(
  config: LocalConfigSet,
): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const providerIds = new Set(Object.keys(config.providers.providers));
  const roleIds = new Set(Object.keys(config.roles.roles));

  validateProviders(config, issues);
  validateRoles(config, issues);
  validateAgents(config, providerIds, roleIds, issues);
  validateTribe(config, roleIds, issues);

  return issues;
}

function validateProviders(
  config: LocalConfigSet,
  issues: ConfigValidationIssue[],
): void {
  for (const [providerId, provider] of Object.entries(
    config.providers.providers,
  )) {
    if (!provider.api_key_env) {
      issues.push({
        file: "providers.yaml",
        field: `providers.${providerId}.api_key_env`,
        message: "Provider api_key_env is required",
      });
      continue;
    }

    if (looksLikeSecretValue(provider.api_key_env)) {
      issues.push({
        file: "providers.yaml",
        field: `providers.${providerId}.api_key_env`,
        message: "Provider api_key_env must reference an environment variable name",
      });
    }
  }
}

function validateRoles(
  config: LocalConfigSet,
  issues: ConfigValidationIssue[],
): void {
  for (const [roleId, role] of Object.entries(config.roles.roles)) {
    validateCapabilityProfile(
      role.required_capabilities,
      "roles.yaml",
      `roles.${roleId}.required_capabilities`,
      issues,
    );
  }
}

function validateAgents(
  config: LocalConfigSet,
  providerIds: Set<string>,
  roleIds: Set<string>,
  issues: ConfigValidationIssue[],
): void {
  const seenAgentIds = new Set<string>();

  config.agents.agents.forEach((agent, index) => {
    const agentPath = agent.id
      ? `agents.${agent.id}`
      : `agents[${index.toString()}]`;

    validateAgentIdentity(agent, index, seenAgentIds, issues);
    validateAgentProvider(agent, providerIds, agentPath, issues);
    validateAgentRoles(agent, roleIds, agentPath, issues);
    validateCapabilityProfile(
      agent.profile,
      "agents.yaml",
      `${agentPath}.profile`,
      issues,
    );
  });
}

function validateAgentIdentity(
  agent: AgentConfig,
  index: number,
  seenAgentIds: Set<string>,
  issues: ConfigValidationIssue[],
): void {
  const agentPath = agent.id
    ? `agents.${agent.id}`
    : `agents[${index.toString()}]`;

  if (!agent.id) {
    issues.push({
      file: "agents.yaml",
      field: `${agentPath}.id`,
      message: "Agent id is required",
    });
    return;
  }

  if (seenAgentIds.has(agent.id)) {
    issues.push({
      file: "agents.yaml",
      field: `${agentPath}.id`,
      message: `Duplicate agent id: ${agent.id}`,
    });
  }

  seenAgentIds.add(agent.id);

  if (!agent.model) {
    issues.push({
      file: "agents.yaml",
      field: `${agentPath}.model`,
      message: "Agent model is required",
    });
  }
}

function validateAgentProvider(
  agent: AgentConfig,
  providerIds: Set<string>,
  agentPath: string,
  issues: ConfigValidationIssue[],
): void {
  if (!agent.provider || !providerIds.has(agent.provider)) {
    issues.push({
      file: "agents.yaml",
      field: `${agentPath}.provider`,
      message: `Unknown provider reference: ${agent.provider || "<missing>"}`,
    });
  }
}

function validateAgentRoles(
  agent: AgentConfig,
  roleIds: Set<string>,
  agentPath: string,
  issues: ConfigValidationIssue[],
): void {
  for (const roleId of agent.eligible_roles) {
    if (!roleIds.has(roleId)) {
      issues.push({
        file: "agents.yaml",
        field: `${agentPath}.eligible_roles`,
        message: `Unknown role reference: ${roleId}`,
      });
    }
  }
}

function validateTribe(
  config: LocalConfigSet,
  roleIds: Set<string>,
  issues: ConfigValidationIssue[],
): void {
  const tribe = config.tribe.tribe;
  const roleReferences = [
    ...tribe.election.required_roles.map((roleId) => ({
      field: "tribe.election.required_roles",
      roleId,
    })),
    ...tribe.execution.help_targets.map((roleId) => ({
      field: "tribe.execution.help_targets",
      roleId,
    })),
    {
      field: "tribe.review.reviewer",
      roleId: tribe.review.reviewer,
    },
  ];

  for (const reference of roleReferences) {
    if (!roleIds.has(reference.roleId)) {
      issues.push({
        file: "tribe.yaml",
        field: reference.field,
        message: `Unknown role reference: ${reference.roleId}`,
      });
    }
  }
}

function validateCapabilityProfile(
  profile: CapabilityProfile,
  file: string,
  fieldPrefix: string,
  issues: ConfigValidationIssue[],
): void {
  for (const [capability, score] of Object.entries(profile)) {
    if (typeof score !== "number" || score < 0 || score > 1) {
      issues.push({
        file,
        field: `${fieldPrefix}.${capability}`,
        message: `Capability score must be between 0 and 1: ${String(score)}`,
      });
    }
  }
}

function looksLikeSecretValue(value: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
    return true;
  }

  return /^(sk-|gho_|AKIA|eyJ)/.test(value);
}

function formatValidationMessage(issues: ConfigValidationIssue[]): string {
  if (issues.length === 0) {
    return "Config validation failed";
  }

  return `Config validation failed: ${issues
    .map((issue) => `${issue.file}:${issue.field}: ${issue.message}`)
    .join("; ")}`;
}
