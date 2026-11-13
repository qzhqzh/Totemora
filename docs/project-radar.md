# 项目情报雷达与行动建议

项目雷达把听风候选与明确的项目目标关联起来，形成“来源证据 → 项目匹配 → 建议核实 → 采纳或忽略 → Lifeline 交接草稿”的流程。默认提供 Totemora、Foundry Studio 两张可编辑项目卡，模式为关闭；项目卡由操作员维护，尚未自动从 EchoMe 或 Lifeline 同步。

## 使用与模式

在 Web 的“项目情报雷达”登录 Operator，编辑项目目标、关注点和排除项，再保存模式。没有 Jev 密钥也可使用规则匹配：

| 模式 | 评估与行动建议 | 自动雷达摘要 |
| --- | --- | --- |
| `off` 关闭 | 不定时评估；手动评估返回 409，可查看既有记录 | 不发送；现有听风推送继续工作 |
| `shadow` 观察 | 每小时及显式手动评估，保存合格行动建议 | 不自动发送雷达摘要；现有听风推送继续工作 |
| `active` 每日精选 | 每小时及显式手动评估，保存合格行动建议 | 普通听风候选等待精选时间；故障或预算不足时暂时回退原链路 |

默认北京时间 19:30、最多 5 条；可调整为 1–5 条。默认每天最多 100 次评估，模型输入预算 50,000 Token。没有合格内容不凑数。`immediate` 当前表示优先关注，仍随每日摘要发送，未增加独立即时推送。

手动评估和摘要预览不会投递消息。`shadow` 不等于全服务静默：既有听风通知，以及显式 Telegram `/radar` 的回复，仍按各自规则发送。切换为 `active` 会启用雷达摘要的外发路径，需要现有 Notifier 目标与成员资产授权支持。

## 规则评估与 Jev

| 字段 / 行为 | 无 Jev 配置的规则路径 | 配置 Jev 的模型路径 |
| --- | --- | --- |
| `evaluation_method` | `rules` | `jev` |
| `model` | `rules:project-focus-v1` | `TOTEMORA_JEV_MODEL`，默认 `jev-latest` |
| 项目匹配 | 原始采集材料命中项目名称或 `focus`；命中 `exclude` 时排除 | 对明确项目卡分别评分 |
| `projects[].confidence` / `decision_confidence` | `null`，不提供模型信心 | Provider 返回的判断信心 |
| `projects[].matched_terms` | 返回实际命中的词 | 可省略 |
| 用量 | 新增规则评估受每日次数限制，消耗 0 模型 Token | 受次数与输入 Token 预算约束 |

规则只做明确文本匹配，不从模糊语义推断项目关系，也不把候选摘要当作原始证据。`focus` 应填写原文可能出现的具体词，例如 `retrieval`、`MCP` 或项目名；规则忽略不足两个字符的词。规则的相关性与材料标记不是模型概率，也不表示事实已经核实。

状态接口的 `configured` 仅表示 Jev Provider 是否配置；`configured:false` 且 `baseline_available:true` 时规则仍可使用。`usage.rules_evaluations` 单列规则次数，`usage.evaluations` 与 `usage.input_tokens` 记录模型预算账本；两种路径共同遵守每日评估次数上限。

配置 Jev 时，`TYPESAFE_API_KEY` 只留在服务端环境，不经 Web 配置或响应返回。模型问题分别衡量项目相关性、新颖度、紧迫性和材料充分度；候选原有 `scores.confidence` 是另一道事实门槛，不能被模型相关性评分替代。缺原文时记录 `review`，不调用模型；调用失败保留失败与预算记录，不伪造成功结果。模型失败后的外发回退不等同于把该次 Jev 结果改写为规则结果。

Jev 输入预算先按请求字节数加保守余量预留，再按返回的实际用量结算；缺少 usage 或失败时保留预留额。这是应用预算，不是供应商账单金额保证。

## 行动建议与交接

只有 `digest` / `immediate` 评估、启用且相关的项目、对应 URL 的原始采集材料，以及通过原有事实和去重门槛的候选，才能生成行动建议。每条建议包含：

- `candidate_id`、`evaluation_id`、`project_id` 及项目名称、目标快照；
- `title`、`rationale`、明确“建议核实”的 `next_step`、`acceptance_criteria`；
- 原文标题、HTTPS 链接、来源和有界摘录组成的 `evidence`；
- 评估来源 `method:rules|jev`、状态、创建时间及决定来源。

行动建议使用确定性的核实步骤，不额外编造发布事实或声称已经完成验证。同候选、同项目只保留一条稳定建议，后续重放不会静默覆盖操作员见过的证据。

状态只能从 `proposed` 进入 `accepted` 或 `dismissed`。Web 与 Telegram 共用同一持久状态和决定账本：同一幂等键、同一请求返回原结果；同键不同请求或试图作出相反决定返回冲突。已决定建议不可静默改写，采纳不会启动执行、排期或发送任务给其他项目。

只有 `accepted` 建议可以读取 Lifeline 草稿。响应固定包含 `destination:"lifeline"`、`status:"draft"`、`submitted:false`、建议内容及来源引用。当前 Gateway 未配置真实目标映射，因此 `project_id`、`phase_id` 为 `null`，`ready:false`，`missing_fields` 列出两者。雷达项目 ID 不等于 Lifeline 项目 ID；不能猜测项目或阶段，也不能把复制草稿描述为已创建任务。

## 摘要与证据门槛

自动评估优先处理最近 24 小时的 AI 候选；显式 `candidate_ids` 可回放历史。摘要只选择最近 24 小时、尚未发送、原有状态具备发送资格、在当前设置生效后评估合格且配置指纹匹配的候选。历史回放、旧设置评估、`held` 候选和已推送消息不会因此重新外发。财经候选与固定晨报不进入此摘要队列。

摘要复用已有候选摘要和来源链接，可附对应行动的下一步提示。采用已经保存的消息快照和条目领取记录后再投递；部分明确失败以相同幂等键重试，Notifier 跳过已成功目标。网络结果未知、发送进程中断时保留 `uncertain`，不自动重放。每日发送时间后有 60 分钟补偿窗口。

打开消息只是阅读信号；“有价值 / 没价值 / 重复 / 太晚”仍使用候选反馈 API，与行动建议的“采纳 / 忽略”分别记录。前者评价信息，后者表示是否继续处理建议。

## Telegram 沟通

`/radar` 在白名单群内返回最多 3 条最近的行动建议及来源，待审核建议提供“采纳 / 忽略”按钮。它读取已有建议，不触发模型评估、Shell、正式任务创建或排期。

使用条件为：Gateway 已配置 Bot Token、群白名单和 Webhook Secret；HTTPS Webhook 可达并接收 `message` / `callback_query`；当前版本已接入雷达命令。普通聊天内容不会触发 `/radar`，不支持通过命令附带执行指令。授权边界是群白名单，尚无独立的群成员级决定权限。

Bot 回复由 Gateway 的双向交互入口承担，独立于 Notifier 的 Telegram 通知目标。只启用 Bark/ntfy 目标不表示 Telegram Bot 已验收；配置 Bot 也不自动创建通用 Telegram 通知目标。重复 update / callback 不重复作决定；部分回复已经发出或结果未知时保留不确定状态，不自动重放整批。配置步骤见 [Telegram Bot](telegram-bot.md)。

## HTTP 接口

以下接口全部需要 Operator Bearer Token，响应为 `Cache-Control:no-store`。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/intelligence/radar` | 设置、评估方式、最近评估、今日模型/规则用量及反馈 |
| `PUT /api/intelligence/radar/settings` | 完整替换有界设置 |
| `POST /api/intelligence/radar/evaluate` | `{ "limit": 10 }`，或附最多 10 个唯一 `candidate_ids`；评估并生成建议，不发送 |
| `GET /api/intelligence/radar/digest` | 当前预览或已冻结的今日摘要与状态 |
| `GET /api/intelligence/radar/actions` | `{ "actions": [...] }`，最近最多 100 条建议 |
| `POST /api/intelligence/radar/actions/{id}/decision` | 接受 `decision:accept|dismiss` 和 `idempotency_key`；返回建议，入口固定来源为 `web` |
| `GET /api/intelligence/radar/actions/{id}/handoff` | 已采纳建议的未提交 Lifeline 草稿；未采纳返回 409，不存在返回 404 |

决定请求示例：

```json
{
  "decision": "accept",
  "idempotency_key": "radar-web-decision-unique-key"
}
```

同一次操作遇到超时应复用原键；换 action 或换决定不能复用该键。键为 1–128 字符，以字母或数字开头，其余允许字母、数字、下划线、点、冒号、连字符。HTTP 不接受客户端自选 `source` 或额外执行字段。

项目卡格式为 `{id,name,goal,focus:[],exclude:[],enabled}`。完整设置包含 `version:1`、`mode`、`projects`、`timezone:"Asia/Shanghai"`、`digest_time`、`digest_limit`、`daily_evaluation_limit`、`daily_token_limit`；`updated_at` 由服务端维护。项目最多 8 个，摘要 1–5 条，评估预算 1–500 项，输入 Token 预算 1,000–250,000。规则模式仍保留同一设置结构。

## 存储与验证

migration 017 保存设置、评估和预算，018 保存摘要快照、发送租约和运行窗口，019 新增 `project_radar_actions` 与 `project_radar_action_decisions`。019 只追加 schema，保留旧业务记录，通过关联约束保证行动引用同一候选的评估；一候选一项目唯一，决定与回执在单个事务中完成，已决定快照不可改写。升级前取得 SQLite 一致性备份，新版启动自动顺序迁移。

离线验证入口：

```bash
bun test packages/server/src/application/project-radar-action-service.test.ts packages/server/src/repositories/project-radar-action-repository.test.ts packages/server/src/migrations/019-project-radar-actions.test.ts
bun test packages/server/src/domains/intelligence/project-radar-baseline.test.ts packages/server/src/application/project-radar-evaluator.test.ts packages/server/src/application/project-radar-digest-service.test.ts
bun test packages/server/src/app-project-radar.test.ts packages/server/src/application/project-radar-telegram.test.ts
bun run typecheck
bun run --cwd packages/web check
bun run test:e2e tests/e2e/project-radar.pw.ts
```

迁移测试从真实 v1–v18 schema 升级，覆盖数据保留、重复执行、非法状态、引用关系和失败回滚；行动测试覆盖证据门槛、幂等冲突及未提交交接。Web 与 Telegram 测试使用独立数据和模拟外部服务，不证明真实 Jev 筛选质量、设备收到消息或 Lifeline 已创建任务。

实际服务库存、外部来源受阻情况与试运行指标见[服务重启与能力清单](service-relaunch.md)。
