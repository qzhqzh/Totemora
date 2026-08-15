# Totemora Git Flow 计划输出契约

仅当 Skill 由 Totemora `git.flow` 专业服务调用时使用本契约。通用 Codex、Gitea 与发布流程仍以主 `SKILL.md` 为准。

专员只输出一个 JSON 对象，不输出 Markdown 或解释：

```json
{
  "summary": "真实改动摘要",
  "commit_message": "fix(scope): summary",
  "files": ["relative/path"],
  "risk": "风险和注意事项",
  "validation_commands": ["来自 Workplace Policy 的原始命令"],
  "experience_used": ["已提供且真实使用的经验 ID"],
  "skill_improvement": "没有可靠改进时为空字符串",
  "self_check": {
    "outcome": "accepted",
    "rationale": "范围、验证和门禁符合规范",
    "issues": []
  },
  "remote_plan": {
    "target_branch": "main",
    "branch_name": "fix/example",
    "issue_title": "fix: example",
    "issue_body": "背景、目标和验收标准",
    "pr_title": "fix: example",
    "pr_body": "改动、验证和风险"
  }
}
```

## 确定性限制

- 当前执行器只实现本地 `commit`、GitHub `pull_request` 和 GitHub `merge` 三种模式。主 Skill 中的 Gitea、release-please、版本发布、开发分支同步、分支清理和部署规则只作为未来图纸；遇到这些目标时输出 `self_check.outcome=rejected`，不得声称已执行。
- `files` 必须是 Totemora 提供的 Git Snapshot 文件子集。
- `validation_commands` 必须是 Workplace Policy 允许命令的子集；计划阶段不得声称已经执行。
- `commit_message` 必须符合 Conventional Commits 和 Workplace Policy 的 type、scope、subject 限制。
- 当前分支不是 `main`/`master` 时，`commit` 模式可以省略 `remote_plan`；当前分支是目标主分支时必须提供安全的短期 `branch_name`，且 `remote_plan.target_branch` 必须等于当前分支，执行器会先创建工作分支。`pull_request` 和 `merge` 模式必须提供完整 `remote_plan`。
- `remote_plan.target_branch` 必须服从仓库声明的分支模型和 Workplace Policy。
- Issue、Push、PR、Merge、发布和部署是独立副作用；计划不得扩大用户与 Policy 已批准的终点。
- `self_check.outcome` 只能是 `accepted` 或 `rejected`；有未解决问题时必须输出 `rejected`。
