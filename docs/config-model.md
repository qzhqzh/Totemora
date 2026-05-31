# Totemora Configuration Model

Configuration files are acceptable for the first version because they keep the product small. They should be treated as the bootstrap format, not the final management experience.

Later versions can add TUI editing, web editing, database storage, and import/export.

## Files

```text
configs/providers.yaml
configs/agents.yaml
configs/roles.yaml
configs/tribe.yaml
```

## Providers

Providers define how Totemora calls model APIs.

Prefer `openai_compatible` as the first adapter type because many providers can use it.

```yaml
providers:
  openai:
    type: openai_compatible
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY

  qwen:
    type: openai_compatible
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api_key_env: DASHSCOPE_API_KEY

  kimi:
    type: openai_compatible
    base_url: https://api.moonshot.cn/v1
    api_key_env: MOONSHOT_API_KEY

  glm:
    type: openai_compatible
    base_url: https://open.bigmodel.cn/api/paas/v4
    api_key_env: BIGMODEL_API_KEY
```

API keys must be referenced by environment variable name. Do not store secrets in config files.

## Agents

Agents are tribe members. They bind a provider model to a capability profile and tool permissions.

```yaml
agents:
  - id: gpt_strategist
    provider: openai
    model: gpt-5
    profile:
      reasoning: 0.95
      coding: 0.85
      review: 0.9
      reading: 0.85
      speed: 0.6
      cost: 0.3
      context: 0.9
      reliability: 0.8
      obedience: 0.85
    eligible_roles:
      - chief
      - shaman
      - reviewer
    tools:
      - file_read
      - web_search
      - code_review

  - id: qwen_executor
    provider: qwen
    model: qwen-plus
    profile:
      reasoning: 0.75
      coding: 0.8
      review: 0.65
      reading: 0.7
      speed: 0.85
      cost: 0.75
      context: 0.7
      reliability: 0.7
      obedience: 0.75
    eligible_roles:
      - warrior
      - worker
    tools:
      - file_read
      - shell
      - file_edit
```

## Roles

Roles define role fitness weights and permissions.

```yaml
roles:
  chief:
    required_capabilities:
      reasoning: 0.35
      review: 0.25
      reliability: 0.25
      obedience: 0.15
    max_agents: 1
    permissions:
      - decide_plan
      - accept_result
      - propose_manual_entry

  shaman:
    required_capabilities:
      reasoning: 0.4
      reading: 0.25
      review: 0.15
      context: 0.2
    max_agents: 1
    permissions:
      - propose_plan
      - advise
      - answer_help_request

  warrior:
    required_capabilities:
      coding: 0.35
      reasoning: 0.2
      tool_use: 0.2
      reliability: 0.25
    max_agents: 3
    permissions:
      - execute_task
      - request_help

  worker:
    required_capabilities:
      speed: 0.3
      cost: 0.25
      obedience: 0.25
      reliability: 0.2
    max_agents: 5
    permissions:
      - summarize
      - run_check
      - transfer_context
      - request_help
```

## Tribe Rules

Tribe rules define how a run operates.

```yaml
tribe:
  id: default
  name: Default Tribe

  election:
    strategy: weighted_score
    required_roles:
      - chief
      - shaman
      - warrior

  council:
    proposal_count: 3
    chief_must_choose_one: true

  execution:
    max_retry_before_help: 2
    help_targets:
      - shaman
      - chief

  review:
    required: true
    reviewer: chief

  manual:
    allow_agent_proposals: true
    auto_apply: false
```

## Provider Adapter Interface

The runtime should call providers through a unified interface.

```ts
interface AgentProvider {
  generate(input: AgentRequest): Promise<AgentResponse>
}

interface AgentRequest {
  messages: TribeMessage[]
  systemPrompt: string
  tools?: ToolDefinition[]
  responseFormat?: "text" | "json"
  maxTokens?: number
  temperature?: number
}

interface AgentResponse {
  content: string
  toolCalls?: ToolCall[]
  usage?: {
    inputTokens: number
    outputTokens: number
    cost?: number
  }
  raw?: unknown
}
```

## Message Protocol

Agents communicate through structured messages.

```ts
type TribeMessageRole =
  | "proposal"
  | "decision"
  | "task_assignment"
  | "progress"
  | "blocker"
  | "help_request"
  | "review"
  | "final_report"

interface TribeMessage {
  id: string
  runId: string
  fromAgent: string
  toAgent?: string
  role: TribeMessageRole
  content: string
  artifacts?: ArtifactRef[]
  requiresResponse?: boolean
}
```
