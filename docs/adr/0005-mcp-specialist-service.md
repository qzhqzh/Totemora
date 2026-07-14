# ADR-0005：以 MCP 暴露稳定的部落专业服务

- 状态：Accepted
- 日期：2026-07-14

## 背景

单个 Skill 依赖调用它的模型正确加载提示词、理解上下文并执行流程。对于 Git 提交、数据校验或部署审批这类需要长期稳定性和积累经验的能力，仅靠 Skill 难以保证服务端状态、安全门禁、独立验收和跨客户端一致性。

Totemora 已经有常驻 Gateway、成员身份、Workplace Policy、Git 流程专员、阶段门禁和验证经验。外部 AI 应能发现并调用这些能力，但不能绕过部落治理直接调用模型或 Shell。

## 决策

Totemora 增加 MCP Adapter，将部落能力发布为稳定服务契约：

```text
Codex / Claude / other MCP host
              │
              ▼
     Streamable HTTP / stdio
              │
              ▼
       Totemora Gateway API
              │
              ▼
Chief -> Capability routing -> Specialist -> Chief acceptance -> Gates -> Final report
```

- MCP 只负责能力发现、参数校验和结果交付，不拥有第二份 Runtime。
- 常驻 Gateway 是部落状态、成员经验和治理的唯一事实来源。
- 第一项 MCP 专业服务是持久 Git Flow：接管已有改动并按请求停在 Commit、已评审 PR 或 Merge。
- 外部 AI 启动一个长期工作流，不需要逐项编排 Git 命令；Chief 负责路由、验收和最终汇报。
- 每个阶段仍需 Policy 和门禁，并校验 Workflow ID、状态、Snapshot Hash、Commit message 和固定确认值。
- HTTP 使用 Bearer Token；本地 stdio 从环境或 `.totemora/operator-token` 读取凭据。
- 工具用 MCP annotations 标明只读或破坏性，方便 Host 设置审批策略。

## 为什么比 Skill 更稳定

- Skill 仍然定义专员做事的方法，但服务端固定执行状态机和安全边界。
- 成员每次从已验证经验和已批准 Skill 版本开始，不依赖调用方保留旧 Session。
- Codex、Claude 或未来云市场调用的是同一个工具契约和同一份部落历史。
- Provider、成员或 Skill 可以演进，而 MCP 工具输入输出保持兼容。

## 当前边界

- 当前使用 MCP TypeScript SDK v1 的稳定版本；不采用 v2 beta。
- Streamable HTTP 采用无 Session 的 JSON 响应模式，适合第一版请求/响应工具。
- Git Flow 规划使用 Gateway 持久任务：启动工具立即返回 `task_id`，外部 AI 可断开后继续查询；Gateway 重启会把中断任务标记为可重试失败。
- local、remote、merge 推进仍是同步写工具，受 MCP Host 的 tool timeout 和写操作审批约束；远端副作用逐步持久化以支持幂等重试。
- 当前 Bearer Token 适用于本机或可信局域网；云市场阶段需要租户、OAuth、审计、配额和计费。
