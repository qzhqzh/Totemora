# Totemora 项目宗旨

Totemora 是一个**预算约束下的异构智能部落**，不是通用聊天产品，也不是把多个模型串成固定流水线的编排框架。

现实中最强模型、上下文和 Token 都是稀缺资源，但用户往往同时拥有多个能力、价格和性格不同的模型。Totemora 要让少量高智能成员负责理解目标、拆解任务、选择人选和验收结果，让成本更低或能力更专门的成员完成边界清晰的工作包，并用运行证据持续改善下一次派工。

## 核心承诺

- **火种与成员分离**：火种是可调用的基础模型；人物由火种、人格、Skills、工具权限、能力画像、经验、历史表现、信任等级和版本共同构成。同一火种可以形成多个成员。
- **按任务组队**：每次 Run 都应说明为何需要这些成员、为何他们适合、实际花费多少，以及结果是否通过验收。
- **智能预算优先**：目标不是调用更多模型，而是在质量、成本和时延约束内使用最小但足够的团队。
- **成长来自证据**：成员成长必须基于可追踪 Run 的评价，经过提案、批准、版本化和回滚；不能让提示词静默自我改写。
- **资产来自实践**：资产包含资产卡、采用图纸和有 Run 证据的部落经验。发现某个工具不等于自动安装或信任它。
- **核心自主可控**：复用 AG-UI、A2A、MCP、OpenTelemetry 等边界协议，但成员、派工、评估、成长和治理属于 Totemora 自己的领域模型。

## 当前产品形态

当前提供 CLI、本地 Web Playground 和 MCP 三种入口。Web 与 MCP 共用常驻 Gateway；MCP 让外部 AI 发现和调用部落专业服务，但不拥有第二套 Runtime。完整的治理控制台仍需在运行数据足够后建设。

当前实现与使用方式见 [quickstart.md](quickstart.md)，领域结构见 [architecture-v2.md](architecture-v2.md)，产品定位见 [ADR-0001](adr/0001-product-positioning-and-delivery-order.md)，驻扎地见 [ADR-0002](adr/0002-settlement-and-continuous-task-intake.md)，技术复用边界见 [ADR-0003](adr/0003-adopt-standards-own-the-domain.md)。推进顺序见 [execution-plan.md](execution-plan.md)。

当前稳定验收节点是 `v0.5.0-git-flow-steward`。Gateway 设计见 [gateway-architecture.md](gateway-architecture.md)，MCP 接入见 [mcp-gateway.md](mcp-gateway.md)，Git 流程决策见 [ADR-0004](adr/0004-development-commit-steward.md)，真实 Issue → PR → Merge 验收见 [v0.5-mcp-git-flow-e2e.md](v0.5-mcp-git-flow-e2e.md)。MCP 专业服务决策见 [ADR-0005](adr/0005-mcp-specialist-service.md)，共享工具资产见 [ADR-0006](adr/0006-tribe-tool-assets.md)。

## 当前成功标准

Totemora 的早期成功不是“多个模型成功回答了一次”，而是用一组真实任务证明：

1. 部落相对单一模型基线，在可接受质量下减少强模型 Token 或总成本；或在同等预算下提高验收通过率。
2. 每次选人、调用、失败和验收都有足够证据解释。
3. 历史表现确实能改善后续派工，而不是只累积更多提示词。

在这些证据成立之前，不优先建设模型市场、复杂 Web、分布式集群、自动微调或无限自治。
