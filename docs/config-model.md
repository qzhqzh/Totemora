# Totemora 配置模型

YAML 是部落的**启动配置**，不是最终管理体验。成员经历、专业任务、反馈、Skill Proposal 和其他活动状态写入 `.totemora/totemora.db`；Secrets、Operator Token、静态 Skill/资产包和不可变 Run 证据仍保留为文件。

权威类型定义在 `packages/core/src/config/types.ts`，可运行示例在 `configs/example/`。本文件解释边界，不复制完整 Schema。

## 文件

```text
configs/example/
├── providers.yaml
├── agents.yaml
├── roles.yaml
└── tribe.yaml
```

## Providers

Provider 只描述模型调用适配，不拥有成员人格、Skill 或历史。凭据应引用环境变量或已有 settings 文件，不能写入仓库。

```yaml
providers:
  openai:
    type: openai_responses
    base_url: https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY

  deepseek:
    type: anthropic_compatible
    settings_file: ~/.claude/settings.ds.json

  cpa:
    type: openai_compatible
    base_url: http://127.0.0.1:31000/v1
    settings_file: ~/star/infra/cpa/config.yaml
```

支持 `openai_responses`、`openai_compatible`、`anthropic_compatible` 和后续注册的适配类型。示例地址不等于部署要求；以实际 `providers.yaml` 为准。

## Members

成员把火种与连续身份组合起来：

```yaml
agents:
  - id: deepseek_git_steward
    name: 执简 · Git流程专员
    provider: deepseek
    model: deepseek-v4-pro[1m]
    status: probation
    version: 1
    persona: 克制、审慎，优先保护已有改动和阶段证据。
    profile:
      reasoning: 0.9
      coding: 0.85
      review: 0.82
      reliability: 0.82
      cost: 0.72
    eligible_roles:
      - warrior
      - worker
    skills:
      - git-change-management
      - conventional-commit
      - verification-planning
      - git-flow-safety
      - pull-request-review
      - github-flow-operations
    tools:
      - git-flow-engine
      - opencode-correction
```

- `profile` 是待证据校准的能力先验，不是事实评分。
- `skills` 是成员可被派工时声明的能力；活动 Skill 包和版本由治理层管理。
- `tools` 是启动期资产授权线索，执行器仍需按动作、风险和 Policy 独立校验。
- `personality`、`lineage` 和 `lifecycle` 形成正式画像与成长边界；运行经历不会直接改 YAML。

状态为 `inactive` 或 `retired` 的成员不会参与正常派工。

## Roles and Tribe

Role 定义岗位能力权重、人数和权限；Tribe 定义 Chief、议事、求助、Review 和手动提案规则。

```yaml
roles:
  reviewer:
    required_capabilities:
      review: 0.45
      reliability: 0.35
      reasoning: 0.2
    max_agents: 2
    permissions:
      - review_result

tribe:
  id: first_tribe
  name: 初火部落
  chief: deepseek_reasoner
  election:
    strategy: weighted_score
    required_roles: [chief]
  council:
    proposal_count: 1
    chief_must_choose_one: true
  execution:
    max_retry_before_help: 2
    help_targets: [reviewer, chief]
  review:
    required: true
    reviewer: chief
  manual:
    allow_agent_proposals: true
    auto_apply: false
```

自然语言任务不能绕过这些配置获得额外权限。专业服务还会叠加 `ServiceBinding`、Workplace Policy 和资产动作门禁。

## Skill and Asset Packages

Skill 不内嵌在 `agents.yaml`：成员配置只引用稳定 Skill ID。规范包位于 `skills/<skill-id>/`，版本、风险、来源和装备证据由 `skill.yaml` 与 SQLite Proposal 管理。用户通过对话创建能力委任，不上传包；见 [Skill 对话治理](skill-governance.md)。

共享资产目录位于 `assets/tool-assets.json`，资产图纸可在 `assets/<asset-id>/` 下维护。Skill 不自动授予资产，资产也不自动改变成员 Skill。

## Validation

```bash
bun run totemora providers list --config-dir configs/example
bun run totemora agents list --config-dir configs/example
bun run totemora tribe inspect --config-dir configs/example
bun run typecheck
bun test packages/core/src/config
```

配置加载失败应阻止启动；未知 Provider、Chief、导师或无效分值不能静默降级。真实 Provider 健康检查会产生模型调用，使用 `providers doctor` 时需明确预算。
