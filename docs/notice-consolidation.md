# 通知项目整合与退役报告

本文是 `notice-ntfy` 能力并入 Totemora 后的 canonical 台账。架构决策见 [ADR-0018](adr/0018-unified-notification-platform.md) 与 [ADR-0019](adr/0019-notice-consolidation-cutover.md)，各领域日常使用见[统一通知平台](notification-platform.md)、[事项提醒](reminders.md)、[优惠雷达](deals.md)和[指定消息转发](forwarded-relay.md)。

## 当前结论

- 业务只运行 Totemora 一套；旧 `notice-ntfy` Compose 不做影子运行或生产回退。
- Bark、Telegram、ntfy 是同一通知平台的三个并列传输通道，ntfy 运行声明归 Totemora。
- reminder、deals、forwarded、AI/财经情报和用户显式启用的定时内容均由 Totemora 的 Specialist Service、SQLite、Web Observatory 和统一派发器承接。
- 旧源码、数据库和凭据位置仍保留为恢复证据；没有删除源数据、volume 或仓库。

## 能力与数据归宿

| 来源 | 结果 | 数据处理 |
| --- | --- | --- |
| `hotspot` | 由听风替代；CISA、USGS、中新网即时进入独立来源健康账本 | 近期成功投递作为 migration 15 去重种子；全部历史与 56 个 X 草稿窗口只读归档 |
| `finance` | 由观潮替代；SEC 与现有 S0–S4 来源继续使用，增加中新网财经 S4 | 近期成功投递作为 migration 15 去重种子；运行日志只读归档 |
| `memo` | 由 `reminder.watch` 接管 | 3 条事项和逐事项投递账本经可重复 importer 迁移 |
| `deals` | 由 `deals.watch` 接管 | 商品终态作为去重种子迁移；运行日志归档 |
| `forwarded` | 由 `forwarded.relay` 接管 | 269 条旧消息与游标经可重复 importer 迁移 |
| `x` | 由 `content.studio` 的显式节律替代 | 旧草稿不伪装成已审校作品；归档保留 |
| `codex-reset` | 退役 | 0 条 reset event；仅基线元数据归档，实际会话恢复由 `codex.supervisor` 负责 |

官方 X/微博 Adapter 没有凭据时保持 disabled。没有为了复刻旧 worker 而引入 Trends24 或公开微博页面抓取，也没有静默改变来源承诺。

## 近期投递证据导入

导入器只读取冻结 SQLite 快照，默认窗口 168 小时。先 dry-run，再使用同一 `source_ref` apply：

```bash
bun run intelligence:evidence import-legacy \
  --domain ai \
  --source /absolute/path/to/frozen-hotspot.db \
  --source-ref notice-ntfy:hotspot:d75fa2d \
  --history-hours 168

bun run intelligence:evidence import-legacy \
  --domain ai \
  --source /absolute/path/to/frozen-hotspot.db \
  --source-ref notice-ntfy:hotspot:d75fa2d \
  --history-hours 168 \
  --apply
```

财经使用同一命令并改为 `--domain finance`。Importer 不接受活动 WAL、相对路径或变化后的同名来源；apply 在单一事务中完成。2026-08-30 的真实导入结果：

| 领域 | 源消息 | 成功投递 | 导入种子 | 窗口外 | 非 HTTPS / 非法 |
| --- | ---: | ---: | ---: | ---: | ---: |
| AI / 热点 | 8,361 | 1,321 | 1,242 | 40 | 39 |
| 财经 | 636 | 103 | 103 | 0 | 0 |

第二次使用同一 AI `source_ref` 执行 apply 时新增 `0` 条，证明幂等。种子到期后自然退出 168 小时去重窗口，不成为永久黑名单。

## 定时内容切流

内容工坊仍默认关闭；只有 Operator 显式启用创作节律才会产生 scheduled 任务。新生成且通过双成员审校的 `ready` 作品会按 `content` 领域路由到已配置目标。手动/Web 作品不自动通知，任何作品都不自动发布到社交平台。

首次部署保存通知 cutover 时间；此前已完成的 scheduled 作品标记为 `suppressed`，不会集中补发。完整正文保留在 Web，通知正文仅发送有界摘要。明确失败使用 5/10/20/40/60 分钟退避；传输结果不确定时停止自动重放。

## 冻结快照回执

以下文件位于 `.totemora/migration-snapshots/`，权限 `0600`，被 Git 忽略：

| 快照 | SHA-256 | 校验摘要 |
| --- | --- | --- |
| `notice-ntfy-hotspot-d75fa2d.db` | `15d9a0840e7021c2dde64eb0d1ba5be491cddecc52a19a7e505d6d687cdaa730` | quick_check ok；8,361 messages / 9,775 runs / 56 drafts |
| `notice-ntfy-finance-d75fa2d.db` | `a9a5b7221b9dbbe6ca6c3e809a31fb0f414f74248bdc10fa499321f9f9bd3736` | quick_check ok；636 messages / 3,006 runs |
| `notice-ntfy-deals-d75fa2d.db` | `fd6a4e006c5b3c864d6f5f0f16fce8285e8f3457a35ccb5e20fa6402b4ea147e` | quick_check ok；4,683 items / 163 runs |
| `notice-ntfy-memo-d75fa2d.db` | `20740fbe1ce8fb8e1f5dc8fb08c03ccd1e9decc152dfd1ab4c6b540a32be107a` | quick_check ok；3 items / 11 deliveries |
| `notice-ntfy-history-d75fa2d.db` | `7e37fdac188683c2262df1f065f6102cb4c71f00566ae0b2fe784b7fbe27bdfd` | quick_check ok；1,067 messages |
| `notice-ntfy-codex-reset-d75fa2d.db` | `b6b00454879f816c74d07c89567a17988c8e30aaf1426818c18c98402085d30b` | quick_check ok；0 reset events |
| `totemora-pre-intelligence-evidence-7766020.db` | `e594a62347e1c334a17ba3f9128250196076cfc0cd68f77fbff4ee282210e09f` | migration 15 落库前回滚点；quick_check ok |

SHA-256 用于确认归档未变化，不代表可以把快照提交到 Git。恢复前必须停止对应写入、先验证副本，并避免覆盖当前 `.totemora/totemora.db`。

## 运行验收

1. `docker ps` 中不得出现旧 `history`、`hotspot-worker`、`finance-worker`、`memo-worker`、`deals-worker`、`forwarded-worker` 或 `codex-reset-worker`；ntfy 传输只允许 `totemora-ntfy`。
2. `totemora-gateway.service` 为 active，Gateway `/` 返回 200，通知平台只返回脱敏目标元数据。
3. 听风来源健康接口可分别显示 RSS、AI HOT、CISA、USGS、官方 X/微博的 ready/degraded 状态；单源失败不阻断其他来源。
4. migration 15 的 AI / finance 种子数量与导入回执一致，重复 apply 为 0 新增。
5. scheduled content 的历史作品只产生 `suppressed` 记录，不产生真实外发；新作品按逐目标 Action Journal 幂等。
6. `codex.supervisor` 继续负责真实会话连接和恢复；不得恢复旧 reset 容器或挂载宿主 `auth.json`。
