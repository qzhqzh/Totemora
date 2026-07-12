# 开发提交专员 v1 规范

## 验收场景

在一个已登记的 Git Workplace 中存在未提交改动。用户只需在统一入口说“按这个项目的规范检查并提交当前改动”。系统必须自动加载该项目保存的规范，由 Chief 委派提交专员，生成可审查计划；用户批准后运行固定验证、创建一个合规提交，并保存可供下一次复用的经验。

## Workplace Policy

每个项目保存：

- 提交规范说明；
- 允许的验证命令；
- Conventional Commit 类型；
- 禁止暂存的路径模式；
- 是否允许在当前分支提交。

Policy 属于 Workplace，不属于聊天 Session。修改 Policy 是显式管理动作并提升版本。

## Commit Proposal

Proposal 必须包含：

- 变更摘要；
- 明确文件列表；
- Conventional Commit message；
- 风险说明；
- 将执行的验证命令；
- Chief 派工理由；
- 专员引用的 Skill 与经验版本；
- 独立 Reviewer 结论；
- Git Snapshot 指纹。

## 批准语义

批准绑定 Proposal ID 和 Snapshot 指纹。批准后如果工作树变化，批准自动失效，必须重新生成 Proposal。批准不包含 push、部署或其他外部动作。

## 成功条件

- 所有验证命令退出码为 0；
- 仅暂存批准文件；
- 提交信息符合 Conventional Commits；
- Git commit 成功且 SHA 被记录；
- 工作流生成可追踪经验；
- 不包含被禁止路径。

## 经验与 Skill 演化

每次成功提交都会为千工写入一条带 Commit SHA 和 Reviewer 结论的验证经验。专员可以基于本次证据提出一条通用 Skill 改进，但不会自动生效。用户在 Web 批准后，Skill 版本提升，改进规则进入下一次全新的专员上下文。若 Skill 在提案后已经升级，旧提案自动失效，避免覆盖新版本。
