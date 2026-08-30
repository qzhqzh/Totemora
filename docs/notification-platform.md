# 统一通知平台

Totemora 使用同一个 `NotificationEnvelope v1` 把已决定外发的内容交给 Bark、Telegram 和 ntfy。通知平台只负责领域路由、逐目标幂等和传输回执，不取代 AI、财经、提醒、优惠等业务领域自己的筛选与状态机。

当前是迁移基础层检查点：Gateway 已能加载三通道目标、查看公开目标元数据并由 Operator 发送受限测试通知；现有 AI / 财经业务仍沿用兼容入口，旧 ntfy workers 也继续负责真实业务外发。完成影子运行和逐域切流前，不应把本检查点描述为旧通知项目已退役。

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

## 迁移门禁

旧 ntfy 项目仍在运行时，统一平台只用于配置验收和后续影子运行。逐域切流必须遵守：先关闭旧 worker 外发，再启用 Totemora 对应领域；任何时刻只能有一边真实发送。停止旧 Compose、撤销公网域名、迁移数据库或轮换凭据仍需单独授权。
