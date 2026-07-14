# ADR-0004：Git 流程专员与阶段门禁

- 状态：Accepted（2026-07-14 修订）
- 原始日期：2026-07-12

## 问题

把 Git 专员限制为本地 Commit，并固定增加另一模型复核，会制造额外延迟和 Provider 故障点，
却不能替代真实 PR Diff、测试退出码、分支保护和远端状态。外部 AI 需要委托一个结果，而不是
自己编排 Issue、Commit、Push、PR 和 Merge。

## 决策

DeepSeek 火种成员 `deepseek_git_steward` 的显示名升级为“执简 · Git流程专员”。他接管用户或
编码成员已经完成的改动，持续负责到所请求的终点：本地 Commit、已评审 PR 或 Merge。

```text
MCP Host / Web / CLI
  -> Chief 接收目标
  -> 能力路由选择具备 git-flow-safety 的成员
  -> 执简读取 Policy、Git Snapshot、Skill 和已验证经验
  -> 执简生成计划并自检
  -> Chief 使用真实 Diff 验收计划
  -> local gate: branch + validation + exact stage + Commit
  -> remote gate: Issue + Push + PR + 真实 PR Diff 自审 + Chief 验收
  -> merge gate: mergeability + squash merge + sync + Chief 最终报告
```

只有一个合格成员时由 Chief 路由器直接选择，不浪费一次模型调用；多个候选时才由 Chief 进行
模型选人。Qwen 不再是固定 Reviewer。高风险任务是否增加第二成员复核，由 Policy、风险或 Chief
动态决定。

## 安全边界

- Workplace 必须登记并保存版本化 Policy。
- 只暂存计划列出的文件，禁止 `git add .`、force push 和任意 Shell。
- 本地、远端、Merge 是三个独立门禁；每个门禁校验状态、Snapshot 与 Commit message。
- GitHub 操作默认关闭，需 Policy 分别允许 Issue、Push、PR 和 Merge。
- PR 评审必须读取真实 PR Diff；发现问题进入 `changes_requested`。
- 每个远端副作用立即持久化编号和 URL，使重试不重复创建资源。
- Merge 只使用 squash，完成后同步 Policy 目标分支并 prune 远端引用。
- `.env`、凭据、私钥、Token 和 Policy 禁止路径不能进入流程。

## OpenCode 工具资产

OpenCode 不是 Git 专员，也不拥有工作流状态。它是验证失败时可选的代码修复执行器：只有
`allow_opencode_fix` 开启时才能调用；运行时通过 inline config 默认拒绝所有权限，只开放读取、
批准文件的编辑、`git status/diff` 和 Policy 验证命令。禁止 `--auto`、外部目录和远端操作。
修复会改变 Snapshot，因此必须回到专员和 Chief 重新审阅，不能沿用旧批准。

## 成长

完成后记录模式、分支、验证、Commit、Issue、PR、专员自检、Chief 验收和最终结果。经验只进入
后续上下文；Skill 改进仍需提案、批准和版本升级。
