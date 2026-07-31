# ADR-0011：SQLite 持久内核与统一专业服务契约

- 状态：Accepted
- 日期：2026-07-23

## 决策

Totemora 把常驻专业能力表示为三个不同生命周期的对象：

1. `SpecialistServiceDefinition` 是代码注册、版本化、强类型的专业能力；
2. `ServiceBinding` 是 Chief 对成员的长期委任和资产授权；
3. `SpecialistTask` 是每次有限、可恢复、可验收的工作单元。

统一的是任务信封、路由、阶段、版本、证据与经验信用，不统一专业状态机。Git Flow
继续使用自己的门禁与 Proposal；听风继续使用候选、派发和反馈领域对象。MCP 保留
`totemora_start_git_flow` 与 `totemora_run_intelligence_brief` 等强类型入口，并新增
只读的服务发现和通用任务查询；不提供可执行任意 prompt 的万能服务。

`.totemora/totemora.db` 是 Gateway 运行状态的唯一写源，启用 WAL、外键、
`busy_timeout` 和短事务。候选 claim、动作幂等、调度租约、反馈、成长批准和专业
任务 revision 都由数据库约束。Secrets、Operator Token、静态资产目录和不可变
Run 证据仍保留为文件。

## JSON 迁移

旧 JSON 按源文件 hash 幂等导入，导入记录写入 `legacy_imports`。迁移不删除旧文件，
但切换后不再双写。`bun run storage:migrate` 导入并写 cutover marker，
`bun run storage:verify` 核对候选、动作、扫描和租约的源数量与数据库数量。
损坏文件或切换后被修改的旧文件会使迁移失败，不能静默跳过。

## 成长证据

事件与成长信用分离：

- `operation`：采集、扫描、模型调用和通知派发，信用为 0；
- `task_outcome`：通过专业验收的有限任务，通常为 1；
- `user_feedback`：Web 明确“有价值”为 1，Bark 打开为 0.2；
- 系统故障与通道故障不扣成员分。

评审至少需要 10 份新信用且满足 7 天冷却。批准后只允许改
`traits`、`communication_style`、`working_preferences`；新 Constitution 从下一次
模型调用起进入系统提示词。Proposal 记录前后版本、实际变更字段和后续 10 份信用的
观察窗口。原则、红线、权限、模型、Skill、导师和历史均不可由成长提案修改。

## 后果

- 常驻服务不等于永不结束的 Task，因而可以重试、验收、审计和计量成长。
- 每 10 分钟扫描不再导致两小时内自动升级。
- SQLite 消除跨 Store 实例丢写、数组截断和非原子 claim。
- 领域快照允许暂时保留 JSON payload；后续按查询需求逐表列化，不阻塞本次切换。
