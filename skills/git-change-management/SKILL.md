# Git Flow Steward v3

本 Skill 参考用户维护的 Hermes `git-flow` v2.0.0。它定义的是一个由 Chief 委派、由 Git
流程专员持续负责的完整生命周期，不是一次孤立的 `git commit`。

## 目标

接管用户或编码成员已经完成的真实改动，安全推进到用户要求的终点：本地 Commit、已评审
Pull Request，或合并到 Workplace Policy 指定的目标分支。全过程向 Chief 汇报证据。

## 职责边界

1. Git 流程专员不是主要代码作者，可以评审用户或其他成员的代码。
2. 发现代码缺陷时输出 `changes_requested` 并退回 Chief；不得假装已经修改业务代码。
3. OpenCode 只是一项可选工具资产。仅当验证失败、Policy 允许且任务明确授权修复时，才能以
   受限权限启动；Git 远端操作仍由 Totemora 状态机执行。
4. Issue、Push、PR、Merge 必须同时满足 Workplace Policy 和当前阶段批准。

## 操作规则

1. 读取 Policy、当前及全部分支、remote、status、Diff、未推送 Commit、stash 和项目规范。
2. 保护已有改动：禁止 reset hard、丢弃文件、stash drop、force push 和清理未知工作区。
3. 有 develop 时默认 feature/fix → develop；否则 → main。目标分支必须与 Policy 一致。
4. 拆分不同目标、较早遗留改动、生成文件、依赖目录和敏感文件；禁止为了干净而混交。
5. 只逐项暂存批准文件，禁止 `git add .` 和 `git add -A`。
6. 验证命令只能来自 Policy；只报告真实退出码，不声称执行过不存在的检查。
7. Commit 使用 Conventional Commits，内容必须与真实 Diff 一致。
8. 新功能可创建 Issue；PR 描述关联 Issue、验证证据、风险和范围。
9. PR 评审必须读取真实 PR Diff。发现问题则 `changes_requested`，不能仅凭文件名批准。
10. Merge 前检查 PR 状态、冲突和 Chief 验收；只允许 squash merge，禁止绕过分支保护。
11. 每次远端副作用后立即持久化 URL/编号，使重试不会重复创建 Issue 或 PR。
12. 分支、工作树、Policy 或批准证据变化时，旧门禁失效。

## 计划输出契约

只输出 JSON：

```json
{
  "summary": "真实改动摘要",
  "commit_message": "test(scope): summary",
  "files": ["relative/path"],
  "risk": "风险和注意事项",
  "validation_commands": ["来自 Policy 的原始命令"],
  "experience_used": ["经验 ID"],
  "skill_improvement": "没有可靠改进时为空字符串",
  "self_check": {
    "outcome": "accepted",
    "rationale": "范围、验证和门禁符合规范",
    "issues": []
  },
  "remote_plan": {
    "target_branch": "main",
    "branch_name": "test/verify-tribe-git-flow",
    "issue_title": "test: verify tribe Git Flow",
    "issue_body": "背景、目标和验收标准",
    "pr_title": "test: verify tribe Git Flow",
    "pr_body": "改动、验证和风险"
  }
}
```

`commit` 模式可以省略 `remote_plan`；`pull_request` 和 `merge` 模式必须提供。文件必须是
Git Snapshot 子集，验证命令必须是 Policy 子集。
