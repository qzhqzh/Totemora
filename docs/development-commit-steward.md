# Git 流程专员

“执简 · Git流程专员”是 DeepSeek 火种孵化的长期成员，负责接管用户或编码成员已经完成的改动。
他不是主要代码作者，因此可以在 PR 阶段评审真实实现；需要修改代码时退回 Chief，或在 Policy
允许时请求受限 OpenCode 工具。

## 三种终点

- `commit`：验证、精确 stage、本地 Commit。
- `pull_request`：继续创建 Issue、Push、PR，读取真实 PR Diff 自审并由 Chief 验收。
- `merge`：继续检查 PR 状态、squash merge 到 Policy 目标分支、清理工作分支并输出 Chief 最终报告。

## 一次授权连续执行

界面和 MCP 默认使用 `workflow` 门禁。用户选定 `commit`、`pull_request` 或 `merge` 终点并检查
计划后，只批准一次；授权会持久绑定模式、Snapshot、Commit message、文件与目标分支，执行器随后连续推进
该终点需要的 local、remote 和 merge 阶段，不在每个阶段重复询问。

原有 `local`、`remote`、`merge` 单阶段门禁仍保留，供旧案卷和人工接管使用。一次授权不包含
版本发布或部署，也不会覆盖 Snapshot、Commit message 或目标模式的变化。

## 成员协作

Chief 收到 MCP 目标后按 `git-flow-safety` 能力路由。只有一个合格成员时直接选择；多个候选时
才运行模型选人。执简生成计划和自检，Chief 使用真实 Diff 验收。Qwen 不再固定参与；安全、
数据库、权限或大范围重构等高风险任务可以动态增加另一成员。

## 失败与恢复

- 模型输出允许从 fenced JSON 或带说明文本中的平衡 JSON 对象恢复；无法恢复时记录成员 ID 和摘要。
- 远端 Issue/PR 编号在每次副作用后立即保存，重试不会重复创建。
- 已授权流程在可调和失败后可从当前阶段继续，无需再次批准相同内容；外部结果未知时仍停止自动重放。
- Snapshot 或 Policy 改变后旧批准失效。
- 验证失败默认停止；`allow_opencode_fix` 开启时，可以在批准文件和验证命令白名单内启动 OpenCode。
  修复后必须重新审阅，不能沿用旧批准。

## 经验

成功工作流会记录模式、分支、验证命令、Commit SHA、Issue/PR、专员自检、Chief 验收和结果。
`skills/git-flow-release/skill.yaml` 声明包的基线版本；Git 服务使用共享运行时常量，并由测试锁定它
与清单一致，再由治理 Store 固定实际活动版本和 Run 证据。`SKILL.md` 使用标准 frontmatter，
宿主界面元数据位于 `agents/openai.yaml`。当前 v4 overlay 只支持在真实成功后追加经验规则，
仍需要治理提案，不会静默修改成员人格、资产权限或外部动作门禁。旧 v3 overlay 会在 SQLite
迁移时重基到 v4；旧 v3 Commission 包保留证据但显式标记过期，需重新试炼。规范见
[Skill 对话治理](skill-governance.md)。

外部调用见 [MCP Gateway](mcp-gateway.md)，真实合并案例见
[v0.5 MCP Git Flow E2E](v0.5-mcp-git-flow-e2e.md)。
