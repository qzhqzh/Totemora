# Totemora 推进计划

本计划以 [ADR-0001](adr/0001-product-positioning-and-delivery-order.md) 为准。每个阶段先通过检查点，再进入下一阶段。

## M2.0 固化可运行基线

目标：把当前未提交的 Provider、CLI、只读 Runtime、Trace、Demo 和文档整理成可审查提交。

验证：`bun test`、`bun run typecheck`、`bun run lint`、`git diff --check` 全部通过；Quickstart 可独立完成一次 Demo。

## M2.1 Run Schema v2 与派工证据（当前）

目标：让每个 Run 能回答选了谁、为什么选、调用多少和验收怎样。

范围：

- Schema 版本和任务类型/特征。
- 成员及 Skill 版本快照。
- 每个工作包的选择理由与选择因素。
- 调用数和 Token 用量；价格未知时不伪造金额。
- 为后续时延、重试、失败归因预留明确的数据落点，但不在本批虚构 Provider 数据。

验证：结构化 Trace 测试覆盖新增字段；旧 Run 文件仍可读取；通用 Demo 产生可检查的派工证据。

## M2.2 Web Playground

目标：让用户不用理解 CLI 参数，也能完成一次部落任务并直观看到 Totemora 的差异化过程。

第一版提供部落成员浏览、任务与验收标准输入、Chief 和预算选择、运行阶段、派工理由、最终报告及完整 Trace。它复用同一个 Runtime，使用本地 Bun HTTP 服务和轮询，不引入数据库或第二套编排逻辑。

验证方式是浏览器能从提交任务走到最终报告；服务默认仅监听 `127.0.0.1`，Workspace 仍为只读。

已按 [ADR-0002](adr/0002-settlement-and-continuous-task-intake.md) 建立持久化 Workplace、Mission、任务历史和任务大厅。Task Analyzer 已能区分 `answer`、`inspect`、`change`、`operate` 与 `continue`；Run 支持取消、结构化失败归因、跨重启 Job 恢复和安全重试。Staffing 已加入 `max_members` 硬预算和能力匹配/成本效率证据骨架，下一步引入基于历史表现的候选排序与总 Token 预算。

## M2.3 Task Analyzer v1

目标：从用户目标、Workspace 和验收标准生成少量稳定特征，避免完全依赖 Chief 临场描述。

先采用规则加 Chief 补充的混合方式，特征至少覆盖任务类型、证据需求、只读/执行权限、复杂度和所需能力。验证方式是对固定任务集产生稳定、可解释的分类。

## M2.4 Budget-aware Staffing v1

目标：在硬预算内选出最小但足够的团队。

对候选成员按任务能力匹配、可靠性、历史表现和成本先验打分，输出入选与未入选理由。Chief 可处理歧义，但不能绕过预算。验证方式是固定 roster 和任务产生确定候选排序，预算收紧时团队规模或成员选择可预测地变化。

## M2.5 Baseline 实验

目标：证明或否定产品核心假设。

增加统一实验入口，对同一任务运行单强模型、固定廉价模型和部落三种策略。首批建立 10 到 20 个只读真实任务，汇总验收通过率、Token、估算费用、时延、重试和失败归因。

检查点：若部落没有稳定收益，停止扩功能，调整 Task Analyzer、Staffing 或产品假设。

## M3 Skills 与资产运行时（骨架已落地）

Skill 已有版本和治理提案；共享资产目录已支持发现、成员授权、动作校验、图纸引用、调用审计和已完成 Git Flow 证据。Zvec 继续作为候选资产，不预设为基础设施。下一步不是扩充资产数量，而是补统一命令策略入口、pre/post hooks、OS sandbox 和 action journal，并用真实 Run 证明资产可靠性。

## M4 成员成长

基于足够 Run 样本生成 profile、persona、Skill 或信任等级变更提案。所有变化需审批、版本化、对照评测和回滚。禁止成员静默改写自己。

## M5 受控执行

第一项受控执行已经完成并扩展为持久 Git Flow：Chief 按能力路由 DeepSeek 火种孵化的“执简 · Git流程专员”，使用 Skill v3、Workplace Policy、Snapshot、固定验证和 local/remote/merge 门禁，把已有改动推进到 Commit、真实 PR Diff 自审和 squash merge。固定 Qwen Reviewer 已移除；第二成员只在风险触发时动态加入。OpenCode 已作为默认拒绝权限的可选修复工具资产接入，代码修复后必须重新审阅。部署和通用外部系统仍保持门禁。

## M6 控制面与生态

在 Trace 和治理模型稳定后建设本地控制面，可用 AG-UI 表达实时事件，通过 MCP/A2A 接入工具或外部 Agent。Web 主要承载观察、审批、回放和成员治理。

Gateway 的平台无关入口边界已形成：Web 与 CLI 共用常驻服务。后续按单一 Adapter 逐步加入聊天、Cron、Webhook 和 IDE，不在每个入口复制 Runtime。

MCP Adapter 的第一个纵向闭环已进入 v0.4：外部 AI 可发现部落、工作地和 Git 提交专员，通过 Streamable HTTP 或 stdio 生成、检查并批准受控 Proposal。Proposal 准备已使用 durable task id + 状态查询，避免受 MCP Host 单次 tool timeout 限制；下一步补充进度事件、任务取消和异步批准。
