# Codex 任务监督器

Codex Supervisor 让 Totemora 通过同一个共享 Codex App Server 观察本机任务，并只对操作员显式选择的任务执行有边界的续跑。它不是第二套 Codex Runtime，也不会把“能看到任务”解释成“有权控制任务”。

当前协议契约锁定 Codex CLI `0.150.1`。升级 Codex 前必须重新运行 App Server 合同测试与真实 smoke test。协议依据见 [Codex App Server 文档](https://developers.openai.com/codex/app-server)。

## 边界与默认值

- 功能开关 `TOTEMORA_CODEX_SUPERVISOR_ENABLED` 默认关闭。
- Observer 列出共享 daemon 的全部 source kinds；未托管任务只写入观察快照。
- Observer 持久化 App Server 返回的 `historyMode`。当前上游不支持完整读取或恢复 `paginated` 线程，因此这类任务只能观察；`manage`、`resume` 和新指令都会 fail closed。
- 任务必须位于已登记 Workplace 的真实路径内，才能进入 `managed`。
- Goal objective 上限为 App Server 契约规定的 4,000 字符。
- 默认 Token 预算 `150,000`，默认截止时间 `72h`，单 Turn 超时 `2h`。
- 全局最多同时监督 2 个任务；同一 canonical worktree 同时最多 1 个。
- 当前 Turn 运行时，新指令使用带 `expectedTurnId` 的 steer；空闲任务才启动新 Turn。
- 5 秒调度冷却，不自动 interrupt 正在运行的 Turn。
- 成功前必须经过独立 verification Turn。
- 基础设施错误按 15 秒、1 分钟、5 分钟重试，最多 3 次；策略替代最多 5 次。
- 所有 App Server 审批都强制 `approvalsReviewer: "user"`；系统审批只能在 Web 回答。

## 运行链路

```text
Codex desktop / CLI ─┐
                     ├─ shared App Server Unix socket
Totemora Observer ───┘          │
                               ▼
                    SQLite Gateway state
                    threads / directives / interactions
                         │       │       │
                         ▼       ▼       ▼
                       Web      MCP   Telegram
```

Totemora 使用 Unix WebSocket 连接现有 App Server，不启动或重启 daemon。`thread/list` 负责观察；只有 `historyMode=legacy` 的任务允许在真正续跑前执行 `thread/resume`，随后使用 goal 与 turn API。

状态阶段为：

```text
observed → aligning → executing → verifying → completed
                         ├→ waiting_decision
                         ├→ waiting_approval
                         ├→ retry_wait
                         ├→ paused
                         └→ failed
```

指令先持久化再投递，并由 lease、fencing token 与 idempotency key 防止重复。`thread/resume` 属于投递前准备：准备失败分别等待 15 秒和 1 分钟，累计尝试三次后暂停，不标记为 `uncertain`。只有 `turn/start` 或 `turn/steer` 已发出但无法确认结果时，指令才进入 `uncertain`；Supervisor 会 fail closed，不自动重放可能已经生效的动作。

## 启用与诊断

共享 daemon 默认 socket：

```text
$CODEX_HOME/app-server-control/app-server-control.sock
```

没有设置 `CODEX_HOME` 时使用当前用户目录下的 `.codex`。systemd 环境示例：

```dotenv
TOTEMORA_CODEX_SUPERVISOR_ENABLED=true
TOTEMORA_CODEX_APP_SERVER_SOCKET=/home/USER/.codex/app-server-control/app-server-control.sock
TOTEMORA_PUBLIC_BASE_URL=https://totemora.example
```

重启 Gateway 后运行：

```bash
bun run totemora codex doctor --gateway-url http://127.0.0.1:4310
```

doctor 使用 Operator Token 检查 feature flag、共享连接、协议版本、最近扫描、任务数量、交互积压、最后错误和不确定投递。`directive_counts.uncertain > 0` 时返回非零退出码并要求操作员检查。Token 从 `TOTEMORA_OPERATOR_TOKEN` 或 `<data-dir>/operator-token` 读取。

## Web 控制台

访问 `/codex` 并登录 Operator Token。页面在可见时每 5 秒读取一次缓存状态，后台标签页每 30 秒读取一次；点击“立即刷新”会先强制扫描共享 App Server，再更新任务列表。

- 顶部：分别显示 `Codex 正在运行` 与 `Totemora 托管中`，避免把客户端运行状态误解为监督状态。
- 左栏：全部任务、正在运行、托管中与需处理任务；搜索标题、Goal、工作地或 ID。
- 中栏：Goal、预算、截止时间、工作地、历史模式、Turn、阶段、任务错误和最近指令/检查点。
- 右栏：FYI、建议、决策和系统审批。
- 移动端：任务、详情、决策三个标签；控制按钮固定在底部。

“开始托管”是唯一从观察进入执行的入口，需要当前 `revision`、不超过 4,000 字符的目标、预算和截止时间。未命中 Workplace 的任务会在 `/codex` 当前页打开登记弹窗；登记后等待下一轮扫描，即可继续托管。分页历史任务会显示“仅观察”说明且不提供托管、恢复或发送指令操作。暂停只阻止后续 Turn，不 interrupt 当前 Turn；停止托管不会删除任务或历史。

视觉基准保存在 [桌面概念稿](design/codex-supervisor-desktop-concept.png) 与 [移动概念稿](design/codex-supervisor-mobile-concept.png)。

## MCP

Operator MCP `/mcp` 增加以下工具：

- `totemora_codex_status`
- `totemora_codex_list_threads` / `totemora_codex_get_thread`
- `totemora_codex_manage_thread`
- `totemora_codex_pause_thread` / `totemora_codex_resume_thread` / `totemora_codex_stop_managing`
- `totemora_codex_send_instruction`
- `totemora_codex_list_interactions` / `totemora_codex_answer_interaction`

Operator MCP 可以回答建议与决策，不能回答 App Server 系统审批。

每个托管 Turn 会获得单独的 capability token，并在 Turn 配置中注入 `/mcp/codex-agent`。服务器只保存 token hash，并把 token 绑定到 thread、turn 与过期时间。这个 agent profile 只有两个工具：

- `codex_raise_interaction`
- `codex_report_checkpoint`

它不能托管任务、回答交互、批准动作或控制其他 Turn。受治理 Skill 位于 `skills/codex-supervised-goal/`，Codex wrapper 位于 `.agents/skills/codex-supervised-goal/`。

## 定时任务定向投递

Codex 控制台支持把少量、明确指定的 Scheduled task 最终结果投递到 Telegram 群。这条链路与 App Server Observer 分离：独立 Scheduled task 每次运行会创建新会话，当前 App Server 也没有暴露稳定的 Automation 身份，因此 Totemora 不按会话标题或某一次 thread ID 猜测任务归属。订阅凭证本身就是稳定、最小权限的任务身份。

边界如下：

- 默认没有任何订阅，最多同时启用 3 个；不会全局转发 Codex 对话。
- 每个订阅只绑定一个当时已在白名单中的 Telegram 群和一份独立 Bearer capability。
- capability 只暴露 `publish_scheduled_digest`，不能列出会话、切换订阅、控制任务或调用其他 Totemora 动作。
- 服务器只保存 token 的 SHA-256 hash；原始 token 只在创建响应中显示一次。
- 每次计划周期使用稳定 `run_key`。每日任务使用 Asia/Shanghai 的 `YYYY-MM-DD`；同一天重试复用相同 key，Action Journal 会跳过已成功投递，未知结果禁止自动重放。
- 每份订阅每个 Asia/Shanghai 自然日最多发送一条不超过 4,000 字符的群消息；即使任务误用其他 `run_key` 再次调用，也不会形成第二条。超长正文会明确标记截断，避免日报变成多条刷屏。

当前交付范围是本地 Codex host 的 Streamable HTTP MCP。它可以让任务在后台完成后发群，用户不必打开该任务会话查看结果；但涉及本地项目的 Scheduled task 仍要求电脑开启且 ChatGPT 桌面应用持续运行。ChatGPT Web Scheduled task 不读取本地 MCP 配置；把这项写操作做成云端 Plugin 前，还需要 OAuth 2.1 授权，当前 Bearer capability 不宣称支持云端。

接入步骤：

1. 打开 `/codex`，登录 Operator Token，在右侧“定时任务订阅”中选择目标群并创建订阅。
2. 立即保存一次性显示的 Streamable HTTP Endpoint 和 Bearer Token。不要把 Token 写入任务 Prompt、仓库、截图或聊天消息；把它放进只供 Codex 进程读取的环境变量，例如 `TOTEMORA_SCHEDULED_NEWS_TOKEN`。
3. 在 `~/.codex/config.toml`，或受信任项目的 `.codex/config.toml` 中为这一份订阅增加独立 MCP 配置；把控制台显示的 Endpoint 代入 `url`：

   ```toml
   [mcp_servers.totemora_scheduled_news]
   url = "https://totemora.example/mcp/codex-scheduled"
   bearer_token_env_var = "TOTEMORA_SCHEDULED_NEWS_TOKEN"
   enabled_tools = ["publish_scheduled_digest"]
   required = true
   ```

4. 重启桌面应用并用 `/mcp` 确认连接，只把控制台生成的“目标任务指令”加入要订阅的 Scheduled task。Codex 当前没有可供 Totemora 校验的稳定 Automation ID；因此服务端验证的是这份独立 capability，而不是按任务标题猜测。MCP 配置在同一 host/项目内可见，Token 的文件和环境变量权限仍需由操作者保护。
5. 手动运行一次目标任务，确认群中只出现一条消息；再检查控制台状态和 `GET /api/actions` 的 `publish_scheduled_digest` 回执。
6. 不再需要时在控制台取消订阅；旧 capability 会立即失效，数据库保留审计记录。

本地 Codex 支持带 Bearer token 的 Streamable HTTP MCP，配置项见 [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)；Scheduled task 的后台运行条件见 [Codex Scheduled tasks](https://learn.chatgpt.com/docs/automations)。投递时必须能访问 `TOTEMORA_PUBLIC_BASE_URL` 的 HTTPS `/mcp/codex-scheduled`。云端接入需另行实现并验证符合 [Plugin OAuth 2.1](https://developers.openai.com/plugins/build/auth) 的授权链路。

## Telegram

原 Telegram webhook 继续作为唯一入口。新增命令：

- `/codex`：连接、已发现任务、Codex 正在运行、Totemora 托管/续跑与积压摘要。
- `/decisions`：显示一项待处理建议或决策及 2–3 个按钮。

只有 `suggest` 与 `decision` 生成 callback button。`approval` 只发送通知和 `/codex` HTTPS 链接，Telegram 无权批准。新交互通知经 Action Journal 去重；每天 Asia/Shanghai 08:30 发送一次监督摘要。

更新命令列表和 webhook：

```bash
bun run telegram:setup
```

## HTTP 控制面

所有 `/api/codex/*` 接口都要求 Operator Bearer Token。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/codex/status` | 连接、扫描、任务、阶段、指令与交互指标 |
| GET | `/api/codex/threads` | 分页列出观察快照 |
| GET | `/api/codex/threads/:id` | 任务、指令与交互详情 |
| POST | `/api/codex/threads/:id/manage` | 显式进入托管 |
| POST | `/api/codex/threads/:id/pause` | 暂停后续监督 |
| POST | `/api/codex/threads/:id/resume` | 恢复已有目标 |
| POST | `/api/codex/threads/:id/stop` | 退出托管，不删除任务 |
| POST | `/api/codex/threads/:id/instructions` | 持久化并排队新指令 |
| GET | `/api/codex/interactions` | 查询交互收件箱 |
| POST | `/api/codex/interactions/:id/answer` | 回答非审批交互 |
| POST | `/api/codex/approvals/:id/respond` | Web-only 系统审批 |
| GET | `/api/codex/scheduled-subscriptions` | 订阅、Telegram 白名单目标和公开 MCP 端点 |
| POST | `/api/codex/scheduled-subscriptions` | 创建一份订阅并一次性返回 capability |
| DELETE | `/api/codex/scheduled-subscriptions/:id` | 按 optimistic revision 撤销订阅 |

`POST /mcp/codex-scheduled` 是独立的 Streamable HTTP MCP capability 入口，不接受 Operator Token，也不暴露 Operator MCP 工具。它只接受创建订阅时签发的 Bearer Token。

所有变更接口使用 optimistic revision。`409` 表示页面状态过期，应刷新后重新确认；断开时返回 `503`；越过 Workplace、分页历史恢复限制或输入边界返回 `422`。

## 观测指标

`/api/codex/status` 提供：

- `enabled`、`connected`、`cli_version`、`last_scan_at`、`next_scan_at`、`last_error`
- `observed_threads`、`running_threads`、`managed_threads`、`active_managed_threads`
- `phase_counts`
- `directive_counts`，其中 `uncertain` 必须人工检查
- `open_interactions` 与 `open_interaction_counts`

Recurring Service 状态中另有 `codex.telegram` 的运行、失败和重叠跳过次数。

## 24 小时 shadow rollout

1. 保持 feature flag 关闭，完成 migration、合同测试、typecheck 和全量测试。
2. 开启 flag，但 24 小时内不点击“开始托管”。确认只有观察快照变化：无新 goal、无 turn/start、无审批代答、无第二个 daemon。
3. 每小时检查 doctor 与 `/api/codex/status`：`connected=true`、扫描持续前进、`last_error` 为空、`directive_counts.uncertain=0`。
4. Shadow 通过后，只托管一个低风险、已登记 Workplace 内的只读任务；验证暂停、恢复、一次决策和 verification Turn。
5. 再逐步开放普通开发任务；保持全局并发 2、单 worktree 并发 1。

回滚时先在 Web 停止托管任务，再把 feature flag 改回 `false` 并重启 Gateway。即使直接关闭，Supervisor 也不会 interrupt 当前 Codex Turn；SQLite 快照和审计记录保留。

## 验证

```bash
bun run --cwd packages/web check
bun run typecheck
bun test
bun run docs:check
bun run lint
```

真实 smoke test 应使用专门的低风险任务，确认跨客户端 `thread/list`、`thread/resume`、goal、turn、reconnect 与 user approval reviewer；测试结束只清理该 smoke task 产生的数据。
