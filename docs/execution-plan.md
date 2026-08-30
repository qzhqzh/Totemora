# Totemora 推进计划

本计划描述当前代码之后的交付顺序。历史节点的具体回归步骤保留在 `v0.x-*-test-guide.md`；产品定位以 [ADR-0001](adr/0001-product-positioning-and-delivery-order.md) 为准，当前持久内核以 [ADR-0011](adr/0011-durable-specialist-service-kernel.md) 为准。

## 已形成的骨架

- GPT、DeepSeek、Qwen、MiMo 与 CPA 图片 Provider 通过统一适配层接入。
- CLI、Web、MCP、Telegram、Cron 共用常驻 Gateway，不复制 Runtime。
- Workplace、Mission、Run、专业任务、候选、反馈、成员经历和治理状态进入 SQLite WAL 内核。
- 通用 Run 提供预算派工、结构化 Trace、取消、恢复、失败归因和独立验收骨架。
- Git Flow、听风、观潮和内容工坊已成为强类型专业服务；Bark、Telegram、Git 状态机和 CPA 生图作为受治理资产留下动作证据。
- Web 已提供任务大厅、部落证据台、成员营帐、火种、资产、AI / 财经双域情报台、内容工坊和审批入口。
- Web 入口已收敛为薄 bootstrap，各界面领域由独立 Feature 持有状态和事件；Prompt/Workflow 模板由 Gateway + SQLite 提供正式定义，不再以浏览器本地状态作为真源。
- 成员画像区分正式内核、观察画像、经历、成长 Proposal 与升级后效果窗口。
- `git-flow-release` 已具备活动版本和经验追加 Proposal，但仍是专用过渡实现。

## 架构治理基线（2026-08-23）

- Gateway 已建立有界 JSON 读取、运行时输入 schema、明确 4xx 语义与脱敏 500 回执；新 route 不得直接使用 `request.json()` 或把未知异常原文返回客户端。
- Ability Template、Skill Registry、Skill Commission、Member、Content、Intelligence、Finance、Development、Run/Job/Intake、Workplace/Settlement、通知与运维路由已从 `server/app.ts` 提取；Development、Intelligence/Finance 和 Content 的后台恢复、排队与专业任务同步由独立 Application Runner 持有。
- SQLite migration 已按版本拆入 `packages/server/src/migrations/` 并由单一注册器顺序执行；版本 1–8 的重复执行和历史数据迁移由测试固定。
- Core Runtime 已分离 Prompt、输出解析/校验和派工证据策略；Git Flow 服务已分离本地 Git/进程边界、GitHub remote client 与模型输出契约，`gh` 返回值在 Adapter 边界完成运行时校验；Development、Intelligence/Finance 的任务与门禁、偏好和 Telegram Update 同样在 HTTP 边界校验。
- Provider Registry 已改为按需解析单个 Provider，CPA 插图连接也延迟到真实配图请求；缺失的可选 Provider 配置不会阻断其他健康模型或无配图任务。当前部署边界由版本化 Archify 图和 canonical 别名共同维护。
- 仍需治理的首要热点是 `server/app.ts`、`development-service.ts` 以及各 600 行以上领域服务；采取按变更触发的局部提取，不做一次性目录搬迁。

## E1：对话式 Skill Commission

目标：用户只通过聊天委任部落学习能力，不接触上传表单和文件格式。

范围：

- SQLite `SkillCommission`、消息、阶段、负责人和来源引用；
- Chief 把自然语言转成澄清问题或结构化 draft proposal；
- Web 首先复用成员营帐的对话语言，增加独立“能力议事”视图；
- Telegram 与 MCP 后续复用同一 Commission ID，不建立各自状态。

验证：至少覆盖“需求不完整继续追问”“URL 只作为来源不自动安装”“同一委任跨重启继续”“用户取消不留下活动 Skill”。

进展：Web 与 MCP 已接入同一 SQLite Commission；Chief 可追问或形成草案，来源和资产权限有确定性门禁，取消不会产生活动版本。Telegram 入口后置。

## E2：规范包、验证与试用

目标：把 Commission 的成果变成可移植、可校验、可比较的 Skill 包。

范围：

- `SKILL.md`、`skill.yaml`、`agents/openai.yaml` 和按需资源目录；
- 目录、frontmatter、引用、脚本和安全静态校验；
- 正例、反例、边界例与无 Skill 基线；
- `draft -> validating -> trial -> active` 状态和包 digest；
- 失败试用保留证据，不自动污染活动版本。

验证：固定用例可复现；脚本实际运行；不同版本的 Run 能按 digest 追溯；验证失败不能进入 trial。

进展：规范包、稳定 digest、静态结构/权限校验和 Git 隔离试用已完成；任意脚本执行仍被禁止，通用沙箱与完整目录导出后置。

## E3：成员装备与效果观察

目标：把“Skill 变好了”变成可量化、可回滚的成员变化。

范围：

- 创建、修订、装备、卸载、晋级、暂停、回滚和退役 Proposal；
- Skill 激活与资产/Secrets/人格/模型权限分离；
- 活动版本、目标成员、专业服务绑定和信任复验；
- Web 展示版本变化、试用任务、基线、验收率、Token、时延和失败归因。

验证：旧 Run 不被新版本重解释；回滚后新任务固定旧 digest；高风险装备始终需要显式批准。

进展：Git 试炼从专业任务自动读取成员、服务、Reviewer、Commission、验收、Token 和时延；三次通过后只形成装备提议，显式批准后加载，回滚后新任务不再加载该版本。

## E4：统一部落专业服务骨架

目标：让下一名专业成员复用任务信封、委任、事件、动作证据、审批和恢复机制，而不是复制 Git、听风或内容工坊代码。

范围：服务注册、任务租约、进度事件、取消、幂等外部副作用、能力/资产断言、验收、经验信用和 MCP 发现。专业状态机仍由各领域拥有。

进展：`finance.watch` 已复用 SpecialistTask、成员绑定、资产断言、候选派发、反馈和经历信用；三个周期值守由同一 `RecurringServiceRunner` 管理，状态持久化并暴露到受保护运维视图，单服务失败和重叠运行互相隔离。Development、Intelligence/Finance 和 Content 的应用任务生命周期已从 App factory 提取；只有新增第五类专业服务时才评估注册式工厂，避免为当前四类服务过度抽象。

验证：观潮的来源故障不影响 AI 情报；两域候选和反馈互不串扰；同一候选对多个 Bark 目标按目标幂等；Gateway 重启后任务和来源健康可恢复。

## E5：稳定性与核心假设复验

目标：证明部落在真实任务上产生稳定的质量或成本收益，而不只是更丰富的界面。

范围：

- 扩展到 10–20 个可重复真实任务；
- 维护带时间和来源的模型价格/额度快照；
- 比较单强模型、固定廉价模型和部落策略；
- 汇总通过率、强模型 Token、总成本、时延、重试、恢复和失败归因；
- 对专业服务执行重启、超时、Provider 降级和外部通道故障演练。

检查点：若部落策略没有稳定收益，优先调整 Task Analyzer、Staffing、Skill 或验收，而不是继续增加成员和界面。

进展：证据台已展示 AI / 财经来源前置门禁、候选/外发/反馈漏斗、成员结果归因和最近收益实验；`core-proof-v1` 提供 10 个固定任务，`cross-domain-proof-v1` 提供跨 5 个 Workspace 的 12 个固定任务，CLI 支持带来源和日期的价格快照。E5 脚本已固定 Workspace、单次输出、部落成员数和每个部落 case 的总 Token 硬上限，并在结果中保留实际门禁。离线稳定性演练已覆盖 Provider 504 归因、周期服务隔离与重启恢复、Gateway 中断任务恢复、Bark 三次失败熔断，并通过真实生产类边界生成结构化回执。

尚缺的是在明确数据外发与费用授权后执行跨领域真实模型对比，并结合受验证的价格快照复核结果。因此当前节点证明了“评测与故障演练可重复”，没有证明“部落策略已经稳定产生收益”。

## 明确后置

- 公共 Skill/模型市场和多租户计费；
- 自动安装未经审查的第三方代码；
- 任意 Shell、无门禁部署和无界自治；
- 自动微调、分布式集群和复杂向量基础设施。
