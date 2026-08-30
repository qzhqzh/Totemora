# ADR-0019：通知项目单运行时切流与能力收口

- 状态：Accepted
- 日期：2026-08-30
- Extends：[ADR-0018](0018-unified-notification-platform.md)

## 背景

ADR-0018 确立了统一通知契约、Bark / Telegram / ntfy 三通道和增量迁移边界。实施过程中进一步明确：独立 `notice-ntfy` 项目不作为生产影子或故障回退运行。若 Totemora 的通知能力故障，应在唯一主线内恢复，而不是重新启动第二套 worker、调度器和历史真源。

旧项目还保留近期已发送热点、财经消息、56 个 X 草稿窗口和一个可选 Codex reset worker。直接忽略这些证据会导致首次扫描重复推送；原样导入又会把旧评分、运行日志和不满足当前治理门禁的草稿伪装成 Totemora 真值。

## 决策

### 唯一运行时

- Totemora 是唯一继续运行和开发的通知业务主线；旧 Compose 的 worker、history、ntfy 和可选 reset 容器保持停止。
- ntfy 仍是 Bark、Telegram 之外的第三个传输通道，其容器与公网 Topic 由 Totemora 的部署声明管理；退役的是独立业务项目，不是 ntfy 协议。
- 旧仓库、SQLite 快照和凭据位置只作为可恢复证据保留，不删除、不作为生产回退启动。

### 能力归宿

| 旧能力 | Totemora 归宿 | 决策 |
| --- | --- | --- |
| `hotspot` | `intelligence.watch` | 替代；补 CISA KEV、USGS significant feed 和中新网即时 RSS，复用候选池、反馈、去重和来源健康账本 |
| `finance` | `finance.watch` | 替代；保留更严格的 S0–S4 证据门禁，并增加中新网财经 S4 发现源 |
| `memo` | `reminder.watch` | 迁移；独立提醒模型、北京时间调度和逐事项投递账本 |
| `deals` | `deals.watch` | 迁移；独立商品、来源健康和冻结小时派发窗口 |
| `forwarded` | `forwarded.relay` | 迁移；唯一许可上游、持久游标和重叠内容去重 |
| `x` | `content.studio` | 由用户显式启用的不定时双人创作替代；仅 scheduled ready 作品通知，仍不自动发布 |
| `codex-reset-worker` | 退役 | 不迁移非官方 reset 信号和“今天是几号”探测；实际会话连接、恢复与监督由 `codex.supervisor` 承担 |

X 官方 API 与微博官方 API 继续是需要凭据后显式启用的来源，不用 Trends24 或公开网页抓取静默替换其可用性。旧 X 草稿只进入归档，因为它们没有 Totemora 要求的双成员贡献与审校证据，不能导入成现代 `ContentWork`。

### 定时内容外发

- 只有 trigger 为 `scheduled` 且结果为 `ready` 的内容作品进入 `NotificationEnvelope v1`，领域为 `content`、类型为 `draft`；Web/手动创作保持静默。
- 完整作品留在 SQLite 与 Web，通知正文按 UTF-8 字节有界，适配 ntfy 消息上限。
- 每个目标继续使用 Action Journal 幂等；明确失败按有界退避重试，`uncertain` 永不自动重放。
- 首次启用时保存持久 cutover 时间。cutover 前已经完成的 scheduled 作品记录为 `suppressed`，不得在部署时集中补发。

### 旧投递证据，不迁移旧判断

Migration 15 只保存最近 168 小时内真正投递成功的 AI / 财经 `source`、`source_id`、HTTPS URL、标题和投递时间。它们只参与模型调用前的重复证据门禁：

- 热点仅接受 `digest_sent`、`immediate`；财经仅接受 `digest_sent`、`immediate_sent`。
- HTTP、非法 URL、非法时间和窗口外记录显式统计并跳过。
- importer 支持 dry-run，以冻结快照 SHA-256 锁定来源，在单一事务内写入，可重复执行且不会产生新种子。
- 不导入旧 AI 分数、摘要、运行日志、拒绝结论或传输认证数据库。

### 归档与恢复

源 SQLite 通过 online backup 或停止写入后的冻结快照保存，快照和回滚备份位于 Git 忽略、owner-only 的 `.totemora/migration-snapshots/`。归档回执、能力台账和导入命令由[通知项目整合报告](../notice-consolidation.md)维护。删除旧数据、撤销域名或轮换凭据仍需要单独授权。

## 未选择

- 不保留生产影子项目或双发开关。
- 不复制 Python workers、旧 History Web、`auth.db` 或 `cache.db`。
- 不把 reminder、deals、forwarded、content 或 ops 伪装成 AI/财经领域。
- 不复制可写的宿主 Codex `auth.json` 挂载；reset 能力不能绕过 `codex.supervisor` 治理边界。

## 结果

六个旧 Topic 和 Codex reset 均有明确归宿；三个通知通道继续可选，但业务状态、调度、来源健康、幂等和 Observatory 只有一套。故障恢复以修复 Totemora 和恢复其 SQLite/Secret 备份为准，不再通过重启独立项目制造第二个真源。
