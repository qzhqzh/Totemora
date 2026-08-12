# Totemora 项目宗旨

Totemora 是一个**预算约束下的异构智能部落**，不是通用聊天产品，也不是把多个模型串成固定流水线的编排框架。

## 文档层级

- 当前产品事实：本文件、[architecture-v2.md](architecture-v2.md)、[quickstart.md](quickstart.md) 和 [execution-plan.md](execution-plan.md)。
- 专题规范：Gateway、MCP、Skill、Bark、Telegram、内容工坊等主题文档。
- 架构决策：`docs/adr/`；新决策用新 ADR 修订，不重写旧决策的历史背景。
- `v0.x-*-test-guide.md`：对应版本的验收快照，只用于复现历史节点，不作为当前能力清单。

现实中最强模型、上下文和 Token 都是稀缺资源，但用户往往同时拥有多个能力、价格和性格不同的模型。Totemora 要让少量高智能成员负责理解目标、拆解任务、选择人选和验收结果，让成本更低或能力更专门的成员完成边界清晰的工作包，并用运行证据持续改善下一次派工。

## 核心承诺

- **火种与成员分离**：火种是可调用的基础模型；人物由火种、人格、Skills、工具权限、能力画像、经验、历史表现、信任等级和版本共同构成。同一火种可以形成多个成员。
- **按任务组队**：每次 Run 都应说明为何需要这些成员、为何他们适合、实际花费多少，以及结果是否通过验收。
- **智能预算优先**：目标不是调用更多模型，而是在质量、成本和时延约束内使用最小但足够的团队。
- **成长来自证据**：成员成长必须基于可追踪 Run 的评价，经过提案、批准和版本化；回滚是治理目标，当前实现先保留版本与效果证据，不能让提示词静默自我改写。
- **资产来自实践**：资产包含资产卡、采用图纸和有 Run 证据的部落经验。发现某个工具不等于自动安装或信任它。
- **核心自主可控**：复用 AG-UI、A2A、MCP、OpenTelemetry 等边界协议，但成员、派工、评估、成长和治理属于 Totemora 自己的领域模型。

## 当前产品形态

当前提供 CLI、本地 Web 和 MCP 三种主要入口，并通过 Telegram、Bark 承接受控通知与反馈。Web、MCP、Telegram、Bark 与 Cron 共用常驻 Gateway、SQLite 状态、成员经历和专业服务；外部 AI 通过 MCP 委托结果，不拥有第二套 Runtime。通用 `totemora run` 与 `onboarding-exam` 仍是直接创建本地 `TribeRuntime + FileRunStore` 的兼容入口，尚未迁移到 Gateway。Web 已提供任务大厅、证据台、成员营帐、火种、资产、AI / 财经双域情报台、内容工坊和审批入口，后续继续补 Skill 议事与效果对照，而不是另建一套控制面。

当前实现与使用方式见 [quickstart.md](quickstart.md)，领域结构见 [architecture-v2.md](architecture-v2.md)，服务器驻扎见 [always-on-gateway.md](always-on-gateway.md)，Gateway 见 [gateway-architecture.md](gateway-architecture.md)，MCP 见 [mcp-gateway.md](mcp-gateway.md)，财经情报见 [finance-intelligence.md](finance-intelligence.md)，Skill 对话治理见 [skill-governance.md](skill-governance.md)，推进顺序见 [execution-plan.md](execution-plan.md)。版本化验收指南属于历史节点快照，不作为当前架构说明。

当前开发节点是 `v0.11.0-finance-intelligence-vertical`：新增独立成员“观潮”和 `finance.watch` 专业服务，以 S0–S4 来源证据、市场/证券语义、确定性质量门和独立反馈历史处理财经情报；Bark 支持按 AI / 财经领域路由多台设备并逐目标熔断。原有内容工坊的听风研究/审校、千工写作、绘影视觉策划/配图责任链保持不变。财经使用见 [finance-intelligence.md](finance-intelligence.md)，决策见 [ADR-0017](adr/0017-finance-intelligence-vertical.md)。

这里的 `v0.11.0-*` 是 `/api/status` 暴露的产品节点标签，不等于根 `package.json` 的包版本或 MCP Adapter 的协议兼容版本。当前三者独立演进；统一版本来源属于产品化整理项。

自动写作默认只在 6–18 小时节律窗口检查一次，并且候选必须同时满足价值、可信度、新颖度、非重复和 72 小时新鲜度门禁；没有合格内容时跳过本轮，不为消耗模型额度制造文章。手动选题仍可随时发起。

下一产品节点是对话式 Skill 治理：用户只需描述希望部落学习的能力或给出参考来源，Chief 形成持久能力委任，组织调研、规范化、受限试用和效果验收；文件是部落维护的后台产物，不提供上传式导入。决策见 [ADR-0016](adr/0016-conversational-skill-governance.md)。

## 当前成功标准

Totemora 的早期成功不是“多个模型成功回答了一次”，而是用一组真实任务证明：

1. 部落相对单一模型基线，在可接受质量下减少强模型 Token 或总成本；或在同等预算下提高验收通过率。
2. 每次选人、调用、失败和验收都有足够证据解释。
3. 历史表现确实能改善后续派工，而不是只累积更多提示词。

在这些证据成立之前，不优先建设模型市场、复杂 Web、分布式集群、自动微调或无限自治。
