# 优惠雷达与旧 deals 迁移

`deals.watch` 是独立优惠领域，不属于 AI 情报或财经判断。它每分钟检查一次当前北京时间小时窗口；每个小时最多真正采集一次公开来源，并把最多 5 条新商品组成一个 `NotificationEnvelope v1` 简报。当前已配置的 `deals` ntfy Topic 会继续收到通知，未来可按同一领域显式增加 Bark 或 Telegram 目标。

## 运行契约

- 默认公开来源为 `https://m.tuihaowu.com/cuxiao.aspx`；只接受 HTTPS、无内嵌凭据的服务端配置，可用 `TOTEMORA_DEALS_SOURCE_URL` 覆盖。
- 上游响应限制为 2 MiB、20 秒，JSON 和 HTML 结构都必须通过运行时校验；单张异常卡片不会阻断有效兄弟条目，但没有任何有效条目时整轮失败。
- `source_id` 是去重真值。每小时冻结最多 5 条 `pending` 项；失败重试复用同一选择和同一幂等键，不会换一批商品。
- 完成后，已选项目进入 `delivered`；未选的新项目进入 `skipped`，与旧 worker 的“每小时最多 5 条”行为一致。
- 网络结果不确定时窗口和商品进入 `uncertain`，禁止自动重发；明确失败可以安全重试。
- ntfy、Bark 或 Telegram 接受只代表传输端接受，不代表用户已阅读。

Gateway 每 60 秒运行一次 `deals.watch`，但 `deal_delivery_windows.local_hour` 唯一约束保证同一北京时间小时只有一个业务窗口。采集、商品状态、窗口与来源健康都写入 Totemora SQLite；旧 Python worker、独立 timer 和历史面板不会被复制进来。

## Operator Observatory

登录 Operator 后，Web 首页的“优惠雷达”显示：

- 最近来源运行状态和完成时间；
- 最近小时窗口、选择数量与派发状态；
- pending、delivered、uncertain、skipped 数量；
- 最近 30 条优惠案卷和公开来源链接。

对应 API 均要求 Operator Bearer Token：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/deals/status` | 返回脱敏来源健康、状态计数和最近派发窗口 |
| `GET` | `/api/deals?status=all&limit=30` | 按状态读取最多 100 条商品证据 |

没有提供任意 URL 采集或任意消息外发接口；来源地址只来自受信任的进程配置。

## 旧 SQLite 导入

旧数据库仍可能有 WAL，不能直接把正在使用过的 `.db` 文件交给导入器。先用 SQLite online backup 生成无 `-wal` 的一致性快照，再执行 dry-run：

```bash
bun run deals import-legacy \
  --source /absolute/path/to/frozen-deals.db \
  --source-ref notice-ntfy:deals:d75fa2d
```

确认 SHA-256、行数和状态数量后再显式写入：

```bash
bun run deals import-legacy \
  --source /absolute/path/to/frozen-deals.db \
  --source-ref notice-ntfy:deals:d75fa2d \
  --apply
```

导入器要求普通文件、无活动 WAL、最大 128 MiB，并校验旧 `items` / `runs` schema。旧 `sent` 映射为 `delivered`；旧 `skipped` 和尚未发送的 `pending` 都映射为 `skipped`，避免切流后把历史商品当成新优惠重发。旧运行日志不进入主业务表，只计入快照审计行数；完整旧数据库继续作为只读恢复档案保留。

同一 `source-ref` 与同一 SHA 重跑返回 `applied: false`；同一逻辑来源的内容发生变化会拒绝静默覆盖。导入元数据只保存逻辑来源、SHA、数量和时间，不保存旧绝对路径。

## 检查命令

```bash
bun run deals status
bun run deals list --status delivered --limit 20
bun test packages/server/src/domains/deals/deal.test.ts \
  packages/server/src/integrations/deals-source-client.test.ts \
  packages/server/src/repositories/deal-repository.test.ts \
  packages/server/src/application/deals-service.test.ts \
  packages/server/src/integrations/legacy-deals-importer.test.ts
```
