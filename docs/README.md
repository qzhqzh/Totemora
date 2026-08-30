# Totemora Documentation

本页是 Totemora 文档入口和事实归属表。代码、测试与文档冲突时，行为以测试和已上线兼容性为准，架构方向以已接受 ADR 和根 `AGENTS.md` 为准。

## 文档生命周期

| 标记 | 含义 | 维护规则 |
| --- | --- | --- |
| Canonical | 当前产品或架构事实 | 实现改变时必须在同一 PR 更新 |
| Current | 当前可用的指南或专题规范 | 命令、路径和安全边界必须可验证 |
| Decision | 已接受的历史决策 | 通过新 ADR 修订，不重写原决策背景 |
| Historical | 特定版本验收快照 | 只用于复现历史节点，不作当前能力清单 |

## 事实归属

| 问题 | 权威入口 | 生命周期 |
| --- | --- | --- |
| Totemora 是什么、成功标准是什么 | 本文档、[Core validation baseline](mvp.md) | Canonical |
| Member、Ember、Skill、Asset、Service 如何组成 | [Architecture v2](architecture-v2.md) | Canonical |
| Gateway、Adapter 和持久状态如何分工 | [Gateway architecture](gateway-architecture.md) | Canonical |
| 当前已完成什么、下一步是什么 | [Execution plan](execution-plan.md) | Canonical |
| 当前部署与组件关系如何可视化 | [Interactive architecture diagram](diagrams/totemora-architecture.html)、[版本与交付规则](diagrams/README.md) | Canonical |
| 如何安装、启动和运行任务 | [Quickstart](quickstart.md) | Current |
| 为什么做出某个架构选择 | [ADR index](adr/README.md) | Decision |
| 如何复现某个旧版本的验收 | [Historical release checks](#历史版本验收快照) | Historical |

## 当前产品事实

Totemora 是一个预算约束下的异构智能部落，不是通用聊天产品，也不是把多个模型串成固定流水线的编排框架。

- **火种与成员分离**：火种是可调用的基础模型；成员由火种、人格、Skill、资产授权、经验、信任和版本组成。
- **按任务组队**：每次 Run 都应解释为何选这些成员、花费多少、谁验收以及是否通过。
- **成长来自证据**：成长必须来自可追踪 Run，并经过提案、批准、版本化和可回滚边界。
- **默认只读**：通用 Run 不从自然语言目标推导 Shell、文件写入、Git、通知或发布权限。
- **单一真源**：Web、MCP、Telegram、Bark、ntfy 和 Cron 共用常驻 Gateway 与 SQLite 状态，不拥有第二套 Runtime。

当前提供 CLI/TUI、本地 Web Gateway 和 MCP 三个主要入口，并以 Bark、Telegram、ntfy 三个并列通道承接受控通知。统一通知平台已完成目标配置、脱敏状态和 Operator 测试入口；旧 ntfy 项目已停止，reminder 与 deals 已分别由 Totemora 的 SQLite、Web、Operator API、可重复导入器与周期调度接管，forwarded 和周期内容领域仍保持显式不可用。Codex 控制台还可为最多 3 个明确的 Scheduled task 创建 Telegram 定向投递订阅。`totemora run` 默认调用 Gateway，只有显式 `--offline` 与 `onboarding-exam` 保留直接创建本地 Runtime 的兼容入口。

当前 npm 语义版本是 `0.12.0`，Gateway 和 MCP 对外暴露的产品发布标识是 `0.12.0-evidence-skill-core`。版本真源位于 `packages/core/src/version.ts`。

## 当前指南与专题规范

### 开发与运行

- [Quickstart](quickstart.md)
- [Development guide](development.md)
- [Configuration model](config-model.md)
- [Always-on Gateway](always-on-gateway.md)
- [Codex task supervisor](codex-supervisor.md)
- [JSON 到 SQLite 升级](storage-migration.md)
- [MCP Gateway](mcp-gateway.md)
- [Git Flow specialist](development-commit-steward.md)

### 专业服务与通道

- [Skill governance](skill-governance.md)
- [Finance intelligence](finance-intelligence.md)
- [Notification transports: Bark and ntfy](internal-bark.md)
- [Telegram bot](telegram-bot.md)
- [Unified notification platform](notification-platform.md)
- [Reminder service and legacy memo migration](reminders.md)
- [Deals radar and legacy deals migration](deals.md)
- [AI HOT source](aihot-source.md)
- [Benchmark](benchmark.md)
- [Stability drills](stability-drills.md)

## 历史版本验收快照

以下文档保留当时的命令、边界和预期结果。它们可以引用现已取代的实现，不得据此覆盖当前 Canonical 文档。

- [v0.2 骨架验收](v0.2-test-guide.md)
- [v0.3 开发提交专员](v0.3-development-steward-test-guide.md)
- [v0.4 MCP Git 提交专员](v0.4-mcp-git-steward-e2e.md)
- [v0.5 MCP Git Flow](v0.5-mcp-git-flow-e2e.md)
- [v0.6 常驻部落](v0.6-living-tribe-test-guide.md)
- [v0.8 情报与成员演化](v0.8-intelligence-and-member-evolution-test-guide.md)
- [v0.9 持久专业服务](v0.9-durable-services-test-guide.md)
- [v0.10 内容工坊](v0.10-content-studio-test-guide.md)
- [v0.12 证据与能力治理](v0.12-evidence-skill-core-test-guide.md)

## 当前成功标准

Totemora 的成功不是“多个模型成功回答了一次”，而是在多次可重复真实任务中证明以下任一结果：

1. 在质量可接受时减少强模型 Token 或总成本。
2. 在相同预算下提高验收通过率。
3. 通过持久状态、确定性资产和经验复用，显著降低重复失败或人工介入。

在证据成立之前，不优先建设模型市场、多租户计费、分布式集群、自动微调或无界自治。
