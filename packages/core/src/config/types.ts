export type CapabilityScore = number;

export type CapabilityName =
  | "reasoning"
  | "coding"
  | "review"
  | "reading"
  | "speed"
  | "cost"
  | "context"
  | "reliability"
  | "obedience"
  | "tool_use";

export type CapabilityProfile = Partial<Record<CapabilityName, CapabilityScore>>;

export type ProviderId = string;
export type AgentId = string;
export type RoleId = string;
export type ToolId = string;
export type PermissionId = string;
export type SkillId = string;

export type MemberStatus =
  | "candidate"
  | "probation"
  | "active"
  | "trusted"
  | "specialist"
  | "inactive"
  | "retired";

export type ProviderType =
  | "openai_compatible"
  | "anthropic_compatible"
  | "openai_responses"
  | (string & {});

export interface ProviderConfig {
  type: ProviderType;
  base_url?: string;
  api_key_env?: string;
  settings_file?: string;
}

export interface ProvidersConfig {
  providers: Record<ProviderId, ProviderConfig>;
}

export interface AgentConfig {
  id: AgentId;
  name?: string;
  provider: ProviderId;
  model: string;
  persona?: string;
  status?: MemberStatus;
  version?: number;
  profile: CapabilityProfile;
  eligible_roles: RoleId[];
  skills?: SkillId[];
  tools: ToolId[];
}

export interface AgentsConfig {
  agents: AgentConfig[];
}

export interface RoleConfig {
  required_capabilities: CapabilityProfile;
  max_agents: number;
  permissions: PermissionId[];
}

export interface RolesConfig {
  roles: Record<RoleId, RoleConfig>;
}

export type ElectionStrategy = "weighted_score" | (string & {});

export interface TribeElectionConfig {
  strategy: ElectionStrategy;
  required_roles: RoleId[];
}

export interface TribeCouncilConfig {
  proposal_count: number;
  chief_must_choose_one: boolean;
}

export interface TribeExecutionConfig {
  max_retry_before_help: number;
  help_targets: RoleId[];
}

export interface TribeReviewConfig {
  required: boolean;
  reviewer: RoleId;
}

export interface TribeManualConfig {
  allow_agent_proposals: boolean;
  auto_apply: boolean;
}

export interface TribeConfig {
  id: string;
  name: string;
  chief?: AgentId;
  election: TribeElectionConfig;
  council: TribeCouncilConfig;
  execution: TribeExecutionConfig;
  review: TribeReviewConfig;
  manual: TribeManualConfig;
}

export interface TribeConfigFile {
  tribe: TribeConfig;
}

export interface LocalConfigSet {
  providers: ProvidersConfig;
  agents: AgentsConfig;
  roles: RolesConfig;
  tribe: TribeConfigFile;
}
