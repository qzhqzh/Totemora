# 事项提醒

Totemora 的 reminder 领域接管旧 `notice-ntfy` 的 `memo` 能力，但不复制 Python worker、独立 Web 面板或第二套调度器。事项、生命周期与投递时间窗写入 Gateway 的 SQLite；Web Observatory、Operator API、CLI 和 `reminder.watch` 共用这一份状态。

## 行为契约

- 截止日按 `Asia/Shanghai` 自然日解释。
- 重要度只允许 `1`、`3`、`5`；事项状态为 `active`、`completed` 或 `expired`。
- 每天北京时间 10:00 汇总距离截止日超过 3 天的 active 事项；空汇总也记录时间窗，防止一分钟轮询反复执行。
- 截止前三天进入加强提醒。每轮只选择当前时刻之前最新的应执行 slot，不补发全部早先 slot。
- 截止日早于今天的 active 事项先转为 expired，再计算外发。
- 完成、过期与恢复都保留记录；当前没有删除 API。

加强提醒沿用封存项目的频率：

| 重要度 | 提前 3 天 | 提前 2 天 | 提前 1 天 | 截止当天 |
| --- | --- | --- | --- | --- |
| 1 | 10:00 | 10:00 | 10:00、18:00 | 09:00、14:00、20:00 |
| 3 | 10:00、18:00 | 10:00、18:00 | 10:00、14:00、20:00 | 08:00、12:00、16:00、20:00 |
| 5 | 10:00、14:00、20:00 | 10:00、14:00、20:00 | 08:00、12:00、16:00、20:00 | 08:00 至 22:00，每两小时一次 |

## 外发与幂等

Reminder 生成 `domain=reminder` 的 `NotificationEnvelope v1`，由统一通知平台按目标策略解析 Bark、Telegram 或 ntfy。旧 iOS 订阅通过 `memo` Topic 兼容；Telegram 不会因为启用 reminder 自动订阅，只有目标文件显式配置 `reminder` 领域时才参与。

每个事项、日期和 slot 都有稳定 delivery key；每个目标通道再由 Action Journal 独立幂等：

- `completed`、`skipped_empty` 不再发送；
- 明确 `failed` 可以用同一幂等键重试；已成功目标只回放回执；
- `uncertain` 禁止自动重放，避免网络结果未知时双发；
- 通道 accepted 只代表传输服务接受，不代表用户已阅读。

## Web 与 Operator API

在 Web 首页打开“事项提醒”，登录 Operator 后可以新增、筛选、完成和恢复事项。接口同样只对 Operator 开放：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/reminders?status=active|completed|expired|all` | 读取有界事项列表 |
| `POST` | `/api/reminders` | 新建事项 |
| `POST` | `/api/reminders/:id/complete` | 标记完成 |
| `POST` | `/api/reminders/:id/reopen` | 恢复为 active |

## CLI 与旧数据导入

日常管理命令：

```bash
bun run reminder list --status active
bun run reminder add --title "完成切流验收" --deadline 2026-09-02 --importance 3
bun run reminder complete --id <reminder-id>
bun run reminder reopen --id <reminder-id>
```

旧库使用 WAL，导入器会拒绝直接读取带活动 WAL 的文件。先在旧服务已停止的前提下制作 SQLite 一致性备份，再 dry-run：

```bash
mkdir -p .totemora/migration-snapshots
sqlite3 /data/04_infra/notice/ntfy/data/memo/memo.db \
  ".backup '.totemora/migration-snapshots/notice-ntfy-memo-d75fa2d.db'"

bun run reminder import-legacy \
  --source /absolute/path/to/.totemora/migration-snapshots/notice-ntfy-memo-d75fa2d.db \
  --source-ref notice-ntfy:memo:d75fa2d \
  --local-date 2026-08-30
```

确认报告中的 active item 与当天 delivery window 数量后，增加 `--apply`。导入在一个事务内完成，使用逻辑 `legacy_ref` 防重复；同一 source ref 的 SHA-256 变化会被拒绝。只导入 active 事项、当天汇总记录和 active 事项当天逐项投递账本；完整历史继续保存在旧 SQLite 只读归档，不塞入主业务表。

Secret、旧数据库绝对路径、标题样本和 ntfy 凭据不会写入导入批次元数据或普通日志。
