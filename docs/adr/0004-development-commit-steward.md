# ADR-0004：开发提交专员与受控提交工作流

- 状态：Accepted
- 日期：2026-07-12

## 问题

用户在不同项目中反复启动 Agent、重新说明开发规范、切换模型、纠正提交方式，并在被污染的长 Session 中继续工作。规范、历史纠正和验证经验没有成为稳定的组织资产。

## 决策

首个可执行 `change` 场景限定为 **提交已有代码改动**。Chief 仍是统一入口，但把 Diff 审阅、验证计划和提交信息交给专精成员“千工”。米探在提交前独立复核证据。任何 Git 暂存、验证命令和提交都必须经过用户对具体计划的批准。

```text
任务大厅 / CLI
  -> Chief 接收 commit_existing 请求
  -> 读取已登记 Workplace Policy
  -> 收集只读 Git Snapshot
  -> 千工加载 git-change-management Skill + 已验证经验
  -> 生成 Commit Proposal
  -> 米探独立复核 Proposal 与 Diff 摘要
  -> 用户批准
  -> 运行已登记验证命令
  -> 仅暂存 Proposal 中的安全路径
  -> 创建 conventional commit
  -> 写入 Run、经验和结果
```

## 安全边界

- 只允许已登记 Workplace。
- 初版不生成或修改业务代码，只提交已经存在的改动。
- `.env`、密钥、凭据、私钥和常见认证文件禁止暂存。
- 不执行模型临时生成的任意命令；只运行用户保存到 Workplace Policy 的验证命令。
- 提交前必须再次检查工作树，若 Diff 与批准时不同则拒绝执行。
- 不自动 push，不 force push，不修改远端。
- Merge、rebase、cherry-pick 冲突状态下拒绝执行。
- 失败不产生提交；已暂存状态恢复到工作流开始前的状态。

## 干净上下文

每次执行创建新的模型请求，只装载：

1. 当前任务；
2. Workplace Policy；
3. 当前 Git Snapshot；
4. `git-change-management` Skill 当前版本；
5. 该成员最近少量已验证经验。

不复用完整聊天 Transcript。Mission 只提供经过压缩的目标和结果，不把历史噪声原样塞入成员上下文。

## 成长

成功提交后记录结构化经验：项目、变更类型、验证命令、Reviewer 结论、提交 SHA 和结果。经验只影响后续上下文与候选证据，不静默修改人格或 Skill。Skill 变更仍需提案、评测、批准和版本升级。

## Hermes 借鉴与代码复用

本设计借鉴 Hermes 的平台无关核心、Gateway 入口、可中断执行、平台 Toolset、Fresh Session、审批和可恢复任务思想。首版没有直接复制 Hermes 源码，因为 Totemora 的 Member、Staffing、Mission 和成长领域不同，且本工作流用现有 Bun Runtime 实现更小。若后续移植 MIT 代码，将在源文件和第三方通知中保留来源、许可证及修改说明。
