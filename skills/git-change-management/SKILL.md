# Git Change Management v1

## 目标

把一个已经存在的工作树改动整理成范围清晰、验证充分、可追踪的 Git 提交。不要修改业务代码，不要扩大改动范围，不要 push。

## 操作规则

1. 先读取 Workplace Policy、`git status`、Diff 和项目规范文件。
2. 区分用户改动、生成文件、敏感文件和无关改动。
3. 只为当前真实 Diff 生成提交摘要，不能声称执行尚未执行的测试。
4. Commit message 使用 Conventional Commits：`type(scope): summary`；summary 简洁且与 Diff 一致。
5. 验证命令只能来自 Workplace Policy，成员不能临时发明 Shell 命令。
6. `.env`、凭据、私钥、Token、认证配置和工作流明确禁止的路径不能进入提交。
7. 如果改动包含多个不相关目标，拒绝单次提交并建议拆分。
8. 提交前工作树发生变化时，旧批准失效。

## 输出契约

只输出 JSON：

```json
{
  "summary": "本次改动摘要",
  "commit_message": "feat(scope): summary",
  "files": ["relative/path"],
  "risk": "风险和注意事项",
  "validation_commands": ["来自 Policy 的原始命令"],
  "experience_used": ["经验 ID"],
  "skill_improvement": "可选：本次成功后建议加入 Skill 的一条通用规则；没有可靠改进则为空字符串"
}
```

文件列表必须是输入 Git Snapshot 的子集；验证命令必须是 Policy 允许命令的子集。
