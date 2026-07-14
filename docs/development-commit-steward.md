# Git 流程专员

“执简 · Git流程专员”是 DeepSeek 火种孵化的长期成员，负责接管用户或编码成员已经完成的改动。
他不是主要代码作者，因此可以在 PR 阶段评审真实实现；需要修改代码时退回 Chief，或在 Policy
允许时请求受限 OpenCode 工具。

## 三种终点

- `commit`：验证、精确 stage、本地 Commit。
- `pull_request`：继续创建 Issue、Push、PR，读取真实 PR Diff 自审并由 Chief 验收。
- `merge`：继续检查 PR 状态、squash merge 到 Policy 目标分支并输出 Chief 最终报告。

## 成员协作

Chief 收到 MCP 目标后按 `git-flow-safety` 能力路由。只有一个合格成员时直接选择；多个候选时
才运行模型选人。执简生成计划和自检，Chief 使用真实 Diff 验收。Qwen 不再固定参与；安全、
数据库、权限或大范围重构等高风险任务可以动态增加另一成员。

## 失败与恢复

- 模型输出允许从 fenced JSON 或带说明文本中的平衡 JSON 对象恢复；无法恢复时记录成员 ID 和摘要。
- 远端 Issue/PR 编号在每次副作用后立即保存，重试不会重复创建。
- Snapshot 或 Policy 改变后旧批准失效。
- 验证失败默认停止；`allow_opencode_fix` 开启时，可以在批准文件和验证命令白名单内启动 OpenCode。
  修复后必须重新审阅，不能沿用旧批准。

## 经验

成功工作流会记录模式、分支、验证命令、Commit SHA、Issue/PR、专员自检、Chief 验收和结果。
Skill v3 的改进仍然需要治理提案，不会静默修改成员人格。

外部调用见 [MCP Gateway](mcp-gateway.md)，真实合并案例见
[v0.5 MCP Git Flow E2E](v0.5-mcp-git-flow-e2e.md)。
