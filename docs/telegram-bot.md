# Telegram 部落 Bot

Telegram 是 Bark 之外的并行通信通道，不替代候选池和价值门禁。听风仍只生成一条候选，
常驻派发器负责把它发送到已配置的 Bark 和 Telegram 群；每个候选、通道、群使用稳定
幂等键，某个通道失败后重试不会重复已成功的通道。

Bot 当前提供：

- 情报群通知，以及“有价值 / 没价值 / 重复 / 太晚”四个反馈按钮；
- `/tribe`：查看在线成员；
- `/news`：查看最近三条候选；
- `/help`：查看用法。

保持 BotFather 的 Group Privacy Mode 开启即可。Telegram 官方说明，隐私模式下 Bot 仍会
收到明确发给它的命令、回复和自身按钮回调；Totemora 不需要读取普通群聊，也不会把
群消息送进模型。命令菜单只是 UI 提示，服务端仍会校验命令和群白名单。

## 1. 创建 Bot 并加入群

1. 在 Telegram 私聊 `@BotFather`，执行 `/newbot`，保存 Bot token；
2. 确认 `/setjoingroups` 已允许加入群；
3. 把 Bot 加入目标群，不需要授予管理员权限；
4. 在群中发送 `/start@你的Bot用户名`。

官方入口：[Bots introduction](https://core.telegram.org/bots)；群隐私模式与命令范围见
[Bot Features](https://core.telegram.org/bots/features#privacy-mode)。Bot token 等同于完整
控制权，不能提交到 Git、写入资产卡或发给模型。

## 2. 写入本机秘密

```bash
mkdir -p .totemora/secrets
printf '%s\n' 'BOTFATHER_TOKEN' > .totemora/secrets/telegram-bot-token
chmod 600 .totemora/secrets/telegram-bot-token
```

在首次设置 Webhook 之前发现群 ID：

```bash
bun run telegram:discover
```

将输出的负数群 ID 写入白名单；多个群可按行或逗号分隔：

```bash
printf '%s\n' '-1001234567890' > .totemora/secrets/telegram-chat-ids
chmod 600 .totemora/secrets/telegram-chat-ids
```

Telegram 的 `getUpdates` 与 Webhook 互斥，所以 `discover` 应在 `setup` 之前执行。官方行为
见 [Bot API: Getting updates](https://core.telegram.org/bots/api#getting-updates)。

## 3. 暴露 HTTPS Webhook

`TOTEMORA_PUBLIC_BASE_URL` 必须是 Telegram 能访问的 HTTPS Gateway 地址。本服务器已有
`star-gateway-nginx` 的 Totemora 反代配置，预期地址是：

```dotenv
TOTEMORA_PUBLIC_BASE_URL=https://totemora.qzhqzh.com
```

执行 `setup` 前必须先确认下面的检查能从公网返回 Gateway 状态；仅存在 Nginx 配置不代表
DNS、证书和 Gateway 进程已经在线：

```bash
curl --fail https://totemora.qzhqzh.com/api/status
```

反向代理需要把下面路径原样转给 Totemora Gateway 的 `4310` 端口：

```text
POST /api/integrations/telegram/webhook
```

然后执行：

```bash
bun run telegram:setup
bun run telegram:doctor
bun run telegram:test
```

`telegram:setup` 会在缺失时生成权限为 `0600` 的
`.totemora/secrets/telegram-webhook-secret`，注册 `message` 与 `callback_query` 两类更新，
并设置 `/help`、`/tribe`、`/news` 菜单。Telegram 会在每个 Webhook 请求中携带
`X-Telegram-Bot-Api-Secret-Token`；Gateway 验证失败返回 401。官方字段说明见
[Bot API: setWebhook](https://core.telegram.org/bots/api#setwebhook)。

## 4. 验收案例

1. `bun run telegram:test`：目标群应收到“Totemora 通道测试成功”；
2. 群中发送 `/tribe@你的Bot用户名`：Bot 应返回在线成员；
3. 等待一条听风候选，点击“有价值”：按钮提示“反馈已交给听风”；
4. Web 人物经历中应增加一条经过验证的 `user_feedback`；
5. `GET /api/actions` 中应看到 `telegram-bot / push_notification` 和
   `telegram-bot / handle_group_update` 证据；
6. 重复投递同一个 Telegram `update_id` 不会重复回复或重复记成长信用。

当前不开放 Telegram `/task` 写操作。发布任务仍从 MCP 或 Web 进入 Chief、工作地和
Operator Token 门禁，避免群内任意成员直接触发代码或外部副作用。
