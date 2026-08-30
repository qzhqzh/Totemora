# 指定 ntfy 消息转发

`forwarded.relay` 接管封存 `notice-ntfy` 项目的 `forwarded-worker`，但不复制旧容器、Shell 循环或历史面板。Totemora 每 60 秒从唯一显式配置的上游 ntfy Topic 做一次有界轮询，把新消息映射为 `domain=forwarded` 的 `NotificationEnvelope v1`，再交给统一通知平台投递。

这是受治理的集成 Adapter，不是任意 URL 订阅器或通用消息代理。上游地址、用户名和密码只存在于 owner-only Secret 文件，不进入 SQLite、API、Web、日志、信封或 Agent Prompt。

## 运行配置

建立一个仅所有者可读写的三行凭据文件：

```text
https://upstream.example.com/topic-name
username
password
```

然后设置绝对路径并重启 Gateway：

```bash
chmod 600 .totemora/secrets/forwarded-source
TOTEMORA_FORWARDED_SOURCE_CREDENTIALS=/absolute/path/to/.totemora/secrets/forwarded-source \
  bun run start:web
```

运行时约束：

- 凭据路径必须指向普通文件，拒绝符号链接、group/world 权限和超过 4 KiB 的内容。
- 上游必须是带 Topic 路径且不内嵌凭据的 HTTPS URL；兼容旧凭据中省略 `https://` 的写法，但仍拒绝显式 HTTP。
- 每轮响应限制为 2 MiB、100 条消息和 20 秒；只接受 ntfy `message` NDJSON 事件。
- Source 在数据库和状态接口中只使用固定公开别名 `legacy-forwarded`，不保存真实 URL 或 Topic。
- 没有显式 Secret 时服务返回 `disabled`，不会猜测旧配置或启动封存项目。

## 消息与投递语义

Relay 保留上游 title、body、priority、tags、click 和 icon；转发标题增加 `↗️ 转发` 标识，tags 增加 `outbox_tray`。不支持的元数据仍留在 Totemora 案卷中。

上游 `message id` 是采集幂等键；每个通知目标继续由 Action Journal 独立幂等：

- `completed`：目标通道已接受，不代表用户已阅读；
- `failed`：明确失败，可使用同一幂等键安全重试；
- `uncertain`：网络结果未知，保持终态并阻止自动重放；
- `deduped`：与迁移历史在 5 分钟内内容一致，只留证据不再次发送。

轮询游标和事件写入 migration 14 创建的 `forwarded_source_state` 与 `forwarded_events`。每轮从已保存游标前 1 秒开始，依靠上游 ID 和内容重叠规则消除边界重复；Gateway 重启不会回到内存起点。

## Operator Observatory

登录 Operator 后，Web 首页的“指定消息转发”展示脱敏来源健康、最近轮询、状态数量和最近 30 条转发案卷。接口均要求 Operator Bearer Token：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/forwarded/status` | 返回配置状态、脱敏来源健康和事件计数 |
| `GET` | `/api/forwarded?status=all&limit=30` | 按状态读取最多 100 条事件 |

没有创建、修改来源或手工发送接口；源配置只能由服务器运维边界提供。

## 旧历史导入

旧 `history.db` 可能仍有 WAL，必须先通过 SQLite online backup 生成冻结快照。导入器默认 dry-run：

```bash
bun run forwarded import-legacy \
  --source /absolute/path/to/frozen-history.db \
  --source-ref notice-ntfy:forwarded:d75fa2d
```

确认 SHA-256、总消息数、forwarded 数量和游标后再显式写入：

```bash
bun run forwarded import-legacy \
  --source /absolute/path/to/frozen-history.db \
  --source-ref notice-ntfy:forwarded:d75fa2d \
  --apply
```

导入只读取 `topic=forwarded` 的历史消息，并将其标记为 `completed`，防止切流后重发。旧 worker 添加的标题前缀和 `outbox_tray` tag 会先还原，再用于与直接上游轮询做内容去重。完整旧历史库继续作为只读恢复档案保留。

同一 `source-ref` 与 SHA 重跑返回 `applied: false`；同一逻辑来源被替换成不同内容会拒绝覆盖。导入元数据不保存源绝对路径。

## 检查命令

```bash
bun run forwarded status
bun run forwarded list --status completed --limit 20
bun test packages/server/src/domains/forwarded/forwarded-event.test.ts \
  packages/server/src/integrations/ntfy-forwarded-source-client.test.ts \
  packages/server/src/repositories/forwarded-repository.test.ts \
  packages/server/src/application/forwarded-relay-service.test.ts \
  packages/server/src/integrations/legacy-forwarded-importer.test.ts
```
