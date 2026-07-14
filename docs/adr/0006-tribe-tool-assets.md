# ADR-0006：确定性执行器作为部落共享资产

- 状态：Accepted
- 日期：2026-07-14

## 决策

把 Git Flow 状态机、OpenCode 适配器、候选基础设施和实践图纸统一建模为**部落资产**。资产不属于某个成员；成员配置只授予使用权。Skill 说明“怎样判断和工作”，资产负责“以可重复方式产生副作用或提供能力”。

资产目录至少声明：稳定 ID、类别、成熟度、版本、执行器、动作、风险、默认权限、Policy 前置条件和采用图纸。每次执行必须绑定成员、工作流、动作、结果和证据。

当前规则：

- `candidate` 和 `disabled` 资产不可执行；高风险资产默认拒绝。
- Chief 只能把任务交给具备相关 Skill 的成员，执行器还要独立校验该成员是否获授资产及动作。
- MCP 对外提供结果导向的长期任务，不暴露任意 Shell 或一组零散 Git 命令。
- 模型负责目标理解、计划、自检和评审；确定性程序负责验证、精确 Stage、Commit、GitHub 操作、状态持久化和门禁。
- 审计写入失败必须显式记录，但不能把已经成功的外部副作用伪装成失败并诱发重复执行。

## 为什么这不是落后方案

成熟 Coding Agent 同样把模型判断和受控工具执行分开。Codex 使用 sandbox、approval、tool annotations 和 hooks；Claude Code 提供分层权限模式；OpenCode 对 Agent、Tool 和 Bash 命令采用可配置权限。差异不在于“是否用确定性代码”，而在于执行层是否具备默认拒绝、最小权限、可恢复状态、审计和操作系统隔离。

Totemora 的独特部分不是重新实现编辑器，而是让多个成员共享这些执行资产，并把授权、派工、验收和经验归属放进部落领域模型。

## 当前实现与缺口

`assets/tool-assets.json` 是初版目录；`ToolAssetRegistry` 提供发现、成员授权、动作校验、调用记录和已完成 Git Flow 证据。Web 展示资产卡，MCP 用 `totemora_list_assets` 暴露发现能力。

当前 Gateway 进程仍以宿主用户权限启动命令。资产权限能阻止编排层误用，但不能替代 OS sandbox。下一阶段按风险顺序补充：统一命令策略入口、pre/post policy hooks、工作目录隔离、进程级 sandbox，以及可重放但不重复副作用的 action journal。

## 参考

- [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing.md)
- [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security.md)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks.md)
- [Claude Code CLI permissions](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [OpenCode agents and permissions](https://opencode.ai/docs/agents/)
- [OpenCode tools](https://opencode.ai/docs/tools/)
