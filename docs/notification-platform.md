# 统一通知平台

Notifier 是本仓库维护、独立构建与升级的通知服务（`packages/notifier`）。Totemora 和其他项目是 HTTP 客户端；Notifier 单独持有 `notifier.db`、目标/密钥配置、收件箱、逐目标发送账本和 Worker。Totemora 的 AI/财经、提醒、优惠、转发、内容等业务仍自行决定**是否**通知；Notifier 只负责接收、路由和投递。外部项目只报告事实；`ops` 是 Notifier 内部分类。

2026-08-30 起，Bark 与 ntfy 传输容器归 `totemora` Compose 管理；旧 `notice-ntfy` 项目不再运行。Notifier 是新增的一份服务代码和一份镜像，不拆成每通道一个镜像。能力归宿及旧项目的去重证据见[通知项目整合报告](notice-consolidation.md)。部署和实际消息状态以容器、Gateway 和诊断命令的实时输出为准；未配置 SMTP 时不发送邮件。

## 目标与 Secret

Notifier 使用七个领域为 Totemora 的既有信封路由；外部接入者不填写领域。旧 Gateway Bark 管理数据需人工核对后复制到 Notifier 配置，不能继续当作 Notifier 的目标真源：

```text
ai · finance · reminder · deals · forwarded · content · ops
```

Notifier 的 Telegram、ntfy 路由目标默认从以下私有文件读取：

```text
.totemora/notifier-data/secrets/notification-targets.json
```

可用 `NOTIFIER_TARGETS_FILE` 指向另一个绝对路径。文件必须是普通文件、非符号链接、最多 64 KiB、仅 owner 可读（容器示例使用 `/run/notifier/notification-targets.json`）：

```bash
chmod 600 .totemora/secrets/notifier/notification-targets.json
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
- Telegram Bot Token 只在 Notifier 的私有 ingress 配置中，`chat_id` 只在私有目标文件中；修改后重启 Notifier。Gateway 的 Telegram Webhook/对话仍是另一个受治理用途，不是第二套通用通知派发器。
- ntfy `server_url` 只允许 HTTPS、本机 loopback HTTP 或同一私有 Compose 网络上的 `http://ntfy`；Bark 同理允许 `http://bark`。跨机器请使用 HTTPS。
- 私有目标文件在 Notifier 启动时读取；Telegram/ntfy 目标目前仍由该文件管理，修改后需重启。Bark、邮件、来源与规则可以改用独立管理页实时保存；见下文“独立管理页面”。
- Operator 目标接口只返回 `id`、label、领域、通道、enabled，以及服务器主机名和由私有 Operator Token 加盐的 12 位目标指纹；不返回完整 Chat ID、device key、邮箱或 authorization。核对错发时比对目标别名与指纹；轮换 Operator Token 后指纹会变化，目标指纹并非“手机已显示”的证明。

## Operator 检查点

Totemora 保留下面两个 Operator Bearer 入口，但目标查询和测试派发由 Gateway 通过 HTTP 委托 Notifier；还可从 Notifier 使用受同一 Notifier Operator Token 保护的 `GET /api/v1/targets`、`POST /api/v1/dispatch`（后者只供受信任的业务客户端发送受校验的公共信封，不接受目标 ID 或 Secret）：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/notifications/platform` | 列出支持的领域、四个通道和脱敏目标元数据；不执行网络健康探测 |
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

## 跨项目事件收件箱

每位客户可以组合一个 Notifier 容器与一个或多个业务容器，按 `source + id` 隔离各服务的事件。它不是 Python 库或 Codex 插件；Python 服务仅需短小 HTTP client，依赖不必与 Totemora 同步升级。Notifier 不 import Gateway 实现，Gateway 依赖 Notifier 的客户端/契约；不能让两个进程同时拥有同一 SQLite 数据目录。

Notifier 启动时读取 `/data/secrets/notification-ingress.json`（独立容器示例挂载在 `/run/notifier/notification-ingress.json`），可用 `NOTIFIER_CONFIG_FILE` 指定绝对路径。服务启动**必须有**随机 `operator_token`；文件须为普通文件、非符号链接、权限 `0600`、最多 64 KiB。不得提交真实 token、SMTP 密码、手机 device key 或私人邮箱。

```json
{
  "schema_version": 1,
  "operator_token": "<至少 32 字符的 Notifier Operator Token>",
  "sources": [{ "id": "backup-box", "token": "<至少 32 字符的随机独立密钥>" }],
  "bark": [{
    "id": "my-phone", "device_key": "<仅 Notifier 保存>",
    "server_url": "http://bark:8080", "domains": ["ops", "ai"], "enabled": true
  }],
  "telegram_bot_token": "<仅在启用 Telegram 目标时填写符合 Telegram 格式的 Bot Token>",
  "rules": [
    {
      "id": "backup-failures",
      "source": "backup-box",
      "type_prefix": "backup.failed",
      "targets": ["email:owner", "bark:my-phone"],
      "coalesce_window_seconds": 300
    }
  ],
  "email": [{ "id": "owner", "address": "owner@example.com", "enabled": true }],
  "smtp": {
    "host": "smtp.example.com", "port": 587, "secure": false,
    "user": "<SMTP账号>", "password": "<SMTP应用密码>", "from": "sender@example.com"
  }
}
```

`rules` 按顺序执行，第一条匹配 `source`（或 `*`）及 `type` 前缀的规则生效；`targets` 写成 `channel:id`，必须已启用并允许内部 `ops` 领域。SMTP 账号、邮件收件人和 Bark device key 都只配置在 Notifier；Telegram/ntfy 目标在 Notifier 的目标配置文件。规则所有目标须可用，否则记作 `unrouted`，不部分发送；无匹配规则也保留为 `unrouted`。相同 `dedupe_key` 在 `coalesce_window_seconds` 内合并同一来源、类型和目标组合，记录仍逐条留痕，不等于第一条已送达。

外部服务可直接向 Notifier，或继续通过 Totemora Gateway 的兼容 URL，调用 `POST /api/integrations/notifications/events`，使用该来源专有的 `Authorization: Bearer <source-token>`。跨机器必须通过 HTTPS 反向代理或可信加密网络；Compose 示例默认只向宿主机 loopback 暴露端口。请求体不接受邮箱、目标、`ops` 分类或任意 URL；只接受以下有界事实：

```json
{
  "schema_version": 1,
  "source": "backup-box",
  "id": "backup-run-20260919-001",
  "type": "backup.failed.disk",
  "title": "备份失败",
  "body": "存储设备未响应；备份任务未完成。",
  "priority": 4,
  "occurred_at": "2026-09-19T09:00:00Z",
  "dedupe_key": "storage-offline"
}
```

`id` 由接入方为每次事实生成稳定值；`source + id` 永久去重。同内容重试得到相同 `event_uuid` 和 `duplicate: true`，同键不同内容返回 409。省略 `occurred_at` 时用首次接收时间落库，同一请求仍可安全重试。`priority` 默认 3；`occurred_at` 与 `dedupe_key` 可省略。请求体最大 16 KiB。成功响应 `202` 仅表示已持久接收，返回 `event_uuid`、`source`、`id`、`status` 和 `duplicate`，不表示通知送达。未经认证返回 401，错误格式返回 400，超大请求返回 413。接入方要把上报设计为**尽力而为、可重试的旁路动作**，通知接收/发送失败不能改写自身备份成功或失败的事实；接入端若需要严格保证上报到达，应自行用 outbox 保留待上报事件。

Worker 每 10 秒领取最多 20 条 `pending` 记录；逐目标 Action Journal 防止重复发送。明确失败保留为 `failed`，结果不确定或进程在发送中中断保留为 `uncertain`，不自动重放。SMTP 使用 TLS（465 隐式 TLS 或 STARTTLS），凭据只在 Notifier 私有配置中，正文为纯文本，收件人只能是预配置目标。未配置真实 SMTP 凭据时不会尝试发送邮件。

Notifier Operator Token 可用于 `GET /api/notifications/events?status=unrouted&limit=50` 查事件、`POST /api/notifications/events/<event_uuid>/retry` **手工**重试确知失败的事件；Gateway 同名兼容 URL 则继续验证 Gateway Operator Token，由 Gateway 代为请求。`uncertain` 不支持自动重放；`unrouted` 不会因改规则自动补发。事件与逐目标回执在独立 `notifier.db`；旧 `totemora.db` 的 migration 16 仅为历史兼容，不再承接新增通知。

无需界面，可从安装了本仓库的主机运行 `bun run notifier:doctor`。它通过受保护的 Notifier HTTP 接口工作；默认连接本机 `127.0.0.1:4321`，从 `.totemora/secrets/notifier-token` 读取 Operator Token（0600），可用 `--url` 和 `--token-file` 指定其他机器的 HTTPS 服务与私有密钥文件：

```bash
bun run notifier:doctor status
bun run notifier:doctor targets
bun run notifier:doctor events --status unrouted
bun run notifier:doctor event <event-uuid>
bun run notifier:doctor deliveries --limit 20
bun run notifier:doctor deliveries --key <idempotency-key>
bun run notifier:doctor test ai bark:second-phone smoke-20260919-01
```

`test` 只向指定且已启用的目标发送服务器生成的固定测试文案，不接受任意收件地址/正文；返回 HTTP 受理与逐目标回执，退出码 0 表示通道确认接收，1 表示未完成，2 表示请求/配置出错。相同测试键和目标只返回历史回执，想真的重发请换一个键；`uncertain` 应先对账，不能靠换键盲目重发。`targets` 显示目标别名、配置服务器与不可逆指纹，帮助排查发错对象但不暴露凭据。`events` 和 `event` 命令只显示路由与状态摘要，不输出事件正文；`deliveries` 提供最近逐目标状态、次数和错误。Bark/ntfy/SMTP 等通道的“成功”表示服务端接受，不等于手机已显示或收件箱已阅读。

## 独立管理页面

在运行新版本 Notifier 的机器上打开 `http://127.0.0.1:4321/admin/`。需要从另一台设备管理时，经受控的 HTTPS 反向代理/可信加密网络访问；Compose 默认只向宿主机 loopback 暴露，**不要**把管理端口直接暴露到公网。使用 `.totemora/secrets/notifier-token` 中的私有 Operator Token 登录（只读本机文件，不把它放进 URL、浏览器书签或聊天记录）；没有单独的网页密码。页面会建立最多 12 小时的 HttpOnly、SameSite=Strict 会话，Token 不放浏览器本地存储；变更接口还要求同源 `Origin`。退出登录后立即失效；Notifier 重启后需要重新登录。

本机一体机的局域网 HTTPS 入口示例为 `ops/nginx/notifier-lan.conf`：保留 Compose 的 `127.0.0.1:4321` 绑定，通过独立域名 `notifier.qzhqzh.com` 仅代理 `/admin/`；Nginx 只允许 `127.0.0.1` 和 `192.168.124.0/24`，其它路径和非局域网请求不可访问。局域网的 DNS/hosts 必须将该域名解析为服务器局域网 IP `192.168.124.2`，否则公开 DNS/CDN 路由不保证可用且不应被加入白名单。安装到同机 HTTPS 网关前按实际域名、网段和证书修改该模板；证书需要覆盖专用域名且正常续期。不要改用明文 LAN HTTP 登录，也不要把手机设备密钥或 Operator Token 放进代理配置。

- “目标与通道”显示实际配置的目标别名、服务器、指纹和 Bark 密钥末四位，可本地核对手机，新增/修改 Bark 目标、设置 SMTP 与收件地址，并在明确确认后发送固定测试消息。密钥和完整收件地址不会回显；末四位相同仍需核对手机所用 Bark 服务器。修改目标不会取消已经在途的旧投递。
- “事件与投递”查看未路由、失败、不确定及逐目标回执；只允许人工重试明确失败的事件，不自动重放未知结果。所有显示的“通道已接受”都**不等于**手机收到或邮件已读。
- “路由规则”管理第一条命中的 `source + type` 前缀规则、目标和合并窗口；“系统设置”创建新的接入来源，随机 Bearer 凭据只显示一次，也可撤销未被规则引用的来源。历史事件的已记录路由不会因规则修改而重写。Telegram/ntfy 目标本轮可查看/测试，仍需通过只读挂载的私有目标文件管理。

首次通过管理页保存后，Notifier 在其可写的 `/data/secrets/notification-admin.json` 原子保存**本次改动的字段**（权限 `0600`，目录 `0700`），立即启用新配置，启动时再与只读挂载的 ingress 输入合并。每个经页面管理过的字段以该文件为准；以后若直接改挂载文件的同一字段，需要先对账，不能期望覆盖页面的配置。`operator_token`、Telegram Bot Token 和 Telegram/ntfy 目标仍由原只读输入管理。升级/迁移/回滚时，要把这个新文件与 `notifier.db` 和原私有配置一起备份，不能只备份数据库。旧 Gateway 的通知管理页仍不是这些目标的真源。

## 构建、组合与切换

Notifier 单独镜像、单独版本，源码仍在当前仓库。示例 `compose.notifier.yaml` 提供单实例、持久 bind mount、私有配置只读挂载、非 root 进程、健康检查和仅 loopback 绑定；可与 `compose.bark.yaml` 在同一个 Compose 项目组合，或在另一台一体机直接使用同一镜像。先创建 `.totemora/secrets/notifier/notification-ingress.json`（上面格式）和 `.totemora/secrets/notifier/notification-targets.json`（Telegram/ntfy 目标格式；无目标时填写 `{"schema_version":1,"telegram":[],"ntfy":[]}`）。两个文件和包含相同 `operator_token` 的 `.totemora/secrets/notifier-token` 都应仅允许 owner 读取；容器中的 `bun` 用户必须有数据目录写权限、能读取两个只读挂载文件及写入 `.totemora/notifier-data/secrets/`。配置真实渠道前不会尝试发送邮件。

若已有 Gateway 私有 Bark/ntfy 目标，可先执行 `bun run notifier:setup` 只读预检，再执行 `bun run notifier:setup --apply` 一次性无覆盖地复制已启用的目标和凭据、生成独立 Operator Token；脚本将已知本机 Bark `127.0.0.1:18080`、ntfy `127.0.0.1:40011` 转为 Compose 内 `bark:8080`、`ntfy:80`。遇到不同的地址或 Telegram 目标会停止并要求人工核对，不会猜测路由；新 `sources`、`rules` 和 SMTP 仍需管理员在 Notifier 侧单独配置。用 systemd 用户服务的 Gateway 可将 `ops/systemd/totemora-notifier-gateway.env` 安装为 `~/.config/totemora/gateway.env`，重启后 Gateway 从已有私有 token 文件读取凭据。

```bash
docker compose -f compose.bark.yaml -f compose.notifier.yaml config --quiet
docker compose -f compose.bark.yaml -f compose.notifier.yaml build notifier
docker compose -f compose.bark.yaml -f compose.notifier.yaml up -d notifier
TOTEMORA_NOTIFIER_URL=http://127.0.0.1:4321 \
  TOTEMORA_NOTIFIER_TOKEN_FILE=/absolute/path/to/.totemora/secrets/notifier-token \
  bun run start:web
```

`TOTEMORA_NOTIFIER_TOKEN_FILE` 必须是绝对路径且权限 `0600`。Gateway 未配置 Notifier 时不会回退到旧通用派发器：内部普通通知视为未配置，跨项目收件返回 `503`，外部系统应以相同 `source + id` 重试。Gateway 原 Bark 管理 API 在启用 Notifier 时返回 `409`，防止误以为更改旧目标会影响新服务。Telegram 双向聊天/Webhook 是另一项 Gateway 功能，不等于通用通知派发。

对已有 Gateway 通知数据，**先停止旧 Gateway 的发送 Worker** 并制作 SQLite 一致性备份，再检查 Notifier 私有目标配置，执行只读预检与离线导入：

```bash
bun run notifier:migrate --source /absolute/path/to/totemora.db --data-dir /absolute/path/to/notifier-data
bun run notifier:migrate --source /absolute/path/to/totemora.db --data-dir /absolute/path/to/notifier-data --apply
```

导入只复制外部事件和 `notification:*` 发送回执，保留 ID、去重键与状态；中断中的 `sending`、`executing` 标为 `uncertain`。重复导入是幂等的，冲突则整体回滚。先核对日志、旧 AI/财经未完成通知以及 Bark/Telegram/ntfy 别名和密钥，再启动 Notifier、设置 Gateway 的 URL 与 token 并启动新版 Gateway。不可让新旧发送进程同时服务同一批事件；不要直接复制活跃 WAL 数据库的 `.db` 单文件。升级 Notifier 时备份其数据库及私有配置，替换同一个镜像版本、在原数据目录启动，保持 HTTP v1 契约兼容；不并行挂载两份活跃容器写同一 SQLite。卸载新镜像并恢复**同一次备份的**旧镜像/数据库是回滚途径，不能在一边已接收新事件后未经对账就恢复旧备份。

## 单项目迁移门禁

旧 `notice-ntfy` Compose 已经停止并移除容器，源仓库、SQLite/WAL、凭据和 bind mount 均未删除。后续只在 Totemora 内开发和修复，不恢复生产影子项目；各领域通过离线一致性快照、dry-run importer、去重种子和验收环境证明行为后再启用。`https://ntfy.qzhqzh.com` 与现有 Topic 继续由 Totemora 管理的 ntfy 传输容器提供。

停止公网入口、删除旧数据、撤销/轮换凭据仍是独立授权操作。

旧六 Topic 可以从 owner-only 凭据文件安全生成目标配置；命令只输出公开 target id、领域与 Topic，不打印 authorization：

```bash
bun run notification:setup-legacy-ntfy \
  --credentials-file /absolute/path/to/worker-auth.md
```

命令会保留已有 Telegram 和自定义 ntfy 目标，以原子写入更新 `.totemora/secrets/notification-targets.json`，权限固定为 `0600`。修改后需要重启 Gateway。
