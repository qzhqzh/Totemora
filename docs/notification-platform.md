# 统一通知平台

Totemora 使用同一个 `NotificationEnvelope v1` 把已决定外发的内容交给 Bark、Telegram 和 ntfy。通知平台只负责领域路由、逐目标幂等和传输回执，不取代 AI、财经、提醒、优惠等业务领域自己的筛选与状态机。

Gateway 已能加载三通道目标、查看公开目标元数据并由 Operator 发送受限测试通知。2026-08-30 起，Bark 与 ntfy 传输容器统一归 `totemora` Compose 管理；旧 `notice-ntfy` 项目已停止全部容器，不再影子运行。现有 AI / 财经业务继续由 Totemora 服务承担；reminder 与 deals 已分别完成 SQLite、Web、Operator API、可重复导入器和周期调度接管，详细契约见[事项提醒](reminders.md)与[优惠雷达](deals.md)。forwarded 和周期内容尚未完成领域迁移时明确保持不可用，不通过恢复旧 worker 隐式补位。

## 目标与 Secret

Bark 目标继续由现有 Bark 管理接口或 `.totemora/secrets/bark-targets.json` 管理。它现在支持以下七个通知领域，并且旧目标在没有显式 `domains` 时仍只接收 `ai`、`finance`：

```text
ai · finance · reminder · deals · forwarded · content · ops
```

Telegram 和 ntfy 的统一路由目标默认从以下文件读取：

```text
.totemora/secrets/notification-targets.json
```

也可以用 `TOTEMORA_NOTIFICATION_TARGETS_FILE` 指向另一个绝对路径。文件必须是普通文件、不能是符号链接、不得超过 64 KiB，且不能允许 group/world 访问：

```bash
chmod 600 .totemora/secrets/notification-targets.json
```

配置格式为：

```json
{
  "schema_version": 1,
  "telegram": [
    {
      "id": "daily-news",
      "label": "每日新闻群",
      "chat_id": "-1000000000000",
      "domains": ["ai", "deals"],
      "enabled": true
    }
  ],
  "ntfy": [
    {
      "id": "legacy-hotspot",
      "label": "旧热点 Topic",
      "server_url": "https://ntfy.example.com",
      "topic": "hotspot",
      "authorization": "Bearer <runtime-secret>",
      "domains": ["ai"],
      "enabled": false
    }
  ]
}
```

- 示例中的 Chat ID、域名和凭据都是占位符，不能提交真实文件。
- Telegram `chat_id` 还必须出现在 `telegram-chat-ids` Secret 或 `TOTEMORA_TELEGRAM_CHAT_IDS` 白名单中，否则 Gateway 启动失败。
- ntfy `server_url` 只允许 HTTPS 或本机 loopback HTTP；认证只在请求时注入。
- 目标文件在 Gateway 启动时读取；修改 Telegram/ntfy 路由后需要重启 Gateway。Bark 管理目标仍按现有服务动态刷新。
- Web/API 只返回目标 `id`、label、领域、通道和 enabled，不返回 Chat ID、device key 或 authorization。

## Operator 检查点

两个入口都要求 Operator Bearer Token：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/notifications/platform` | 列出支持的领域、三个通道和脱敏目标元数据；不执行网络健康探测 |
| `POST` | `/api/notifications/platform/test` | 发送服务器生成的测试文本，只接受领域、通道和稳定幂等键 |

测试请求示例：

```json
{
  "domain": "ops",
  "target_channels": ["bark", "telegram", "ntfy"],
  "idempotency_key": "operator-smoke-2026-08-30-01"
}
```

相同幂等键、相同目标会返回已保存回执，不会再次发送。明确失败的目标可以用同一键重试；结果不确定时 Action Journal 会阻止自动重放。测试接口不接受自定义标题或正文，避免把控制面变成任意消息代理。

## 单项目迁移门禁

旧 `notice-ntfy` Compose 已经停止并移除容器，源仓库、SQLite/WAL、凭据和 bind mount 均未删除。后续只在 Totemora 内开发和修复，不恢复生产影子项目；各领域通过离线一致性快照、dry-run importer、去重种子和验收环境证明行为后再启用。`https://ntfy.qzhqzh.com` 与现有 Topic 继续由 Totemora 管理的 ntfy 传输容器提供。

停止公网入口、删除旧数据、撤销/轮换凭据仍是独立授权操作。

旧六 Topic 可以从 owner-only 凭据文件安全生成目标配置；命令只输出公开 target id、领域与 Topic，不打印 authorization：

```bash
bun run notification:setup-legacy-ntfy \
  --credentials-file /absolute/path/to/worker-auth.md
```

命令会保留已有 Telegram 和自定义 ntfy 目标，以原子写入更新 `.totemora/secrets/notification-targets.json`，权限固定为 `0600`。修改后需要重启 Gateway。
