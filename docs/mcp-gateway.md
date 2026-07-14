# Totemora MCP Gateway

MCP 对外发布的是一个持久的“部落 Git Flow 能力”。调用方 AI 只描述目标和终点；Chief 负责
路由、包装、验收和最终汇报，Git 流程专员负责内部阶段。MCP Adapter 不直接调用模型或 Shell，
所有状态都落在常驻 Gateway。

## 工具

| Tool | 用途 |
| --- | --- |
| `totemora_status` | 查看 Gateway、成员和能力 |
| `totemora_list_workplaces` | 查看工作地和 Policy |
| `totemora_list_assets` | 查看部落资产、成熟度、成员授权、策略要求和运行证据 |
| `totemora_start_git_flow` | 委托一个 `commit`、`pull_request` 或 `merge` 结果，立即返回 `task_id` |
| `totemora_get_task` | 查询 Chief 路由和规划任务 |
| `totemora_list_git_flows` | 查看历史工作流及当前门禁 |
| `totemora_get_git_flow` | 核对文件、Snapshot、计划、自检、Chief 验收、PR 评审和结果 |
| `totemora_advance_git_flow` | 批准同一工作流的 `local`、`remote` 或 `merge` 门禁 |

这不是把 Git 命令拆成 MCP 微工具。调用方只启动一次工作流并持有 `workflow_id`；阶段划分属于
部落内部状态机。模型调用或客户端断开不会丢失 `.totemora/development-tasks/` 中的任务。
Git Flow Engine 是部落共享资产，当前由执简获授；以后其他成员只需经过配置授权即可复用同一确定性能力。

## 启动与配置

```bash
TOTEMORA_HOST=0.0.0.0 bun run dev:web
export TOTEMORA_OPERATOR_TOKEN="$(tr -d '\n' < /home/zhuqin/star/app/Totemora/.totemora/operator-token)"
```

```toml
[mcp_servers.totemora]
url = "http://127.0.0.1:4310/mcp"
bearer_token_env_var = "TOTEMORA_OPERATOR_TOKEN"
default_tools_approval_mode = "writes"
tool_timeout_sec = 240
enabled = true

[mcp_servers.totemora.tools.totemora_advance_git_flow]
approval_mode = "prompt"
```

本地 stdio bridge 使用 `bun run mcp:stdio`，仍连接同一个 Gateway。

## 调用方式

```text
查找 Totemora 中当前项目的 Workplace，把现有改动委托给部落 Git Flow 能力，
终点是 reviewed pull request。先启动并查询工作流，不要越过当前门禁。
```

调用方检查工作流后，在用户授权范围内使用 `totemora_advance_git_flow`。工具要求同时提交当前
status、Snapshot Hash、Commit message 和固定 confirmation，防止批准未查看或已经过期的计划。

## 门禁与 Policy

- `local`：验证、创建批准分支、精确 stage、Commit。
- `remote`：按 Policy 创建 Issue、Push、PR；专员读取真实 PR Diff 自审；Chief 验收。
- `merge`：检查 PR 状态，squash merge，更新目标分支，Chief 输出最终报告。
- GitHub 远端权限默认全部关闭，必须在 Workplace Policy 显式开启。
- OpenCode 修复默认关闭，且永远不能执行 Git 远端操作。

真实案例见 [v0.5 MCP Git Flow E2E](v0.5-mcp-git-flow-e2e.md)。
