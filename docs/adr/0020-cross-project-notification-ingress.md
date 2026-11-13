# ADR-0020：跨项目通知收件箱与可拆部署边界

状态：Superseded（部署形态由 [ADR-0021](0021-independent-notifier-service.md) 取代；事件和投递语义继续沿用）

关系：扩展 [ADR-0018](0018-unified-notification-platform.md) 的三个传输通道为 Bark、Telegram、ntfy、SMTP 邮件；保留“公共信封不携带目标 ID / Secret”和逐目标 Action Journal 的约束。沿用 [ADR-0019](0019-notice-consolidation-cutover.md) 的单一状态真源，不恢复旧项目影子运行。

## 背景与选择

其他一体机和服务需要上报备份、运行等事实，而不应复制 Totemora 的邮箱、收件人和推送配置。直接让各项目调用原平台测试入口，会混淆 Operator 权限、任意正文和事实记录；先拆独立微服务会引入第二套数据库/发布/身份管理。目前使用模块化单体：Gateway 提供版本化、逐来源认证的 HTTP 接口，应用层拥有事件收件箱，存储层用同一 SQLite，传输仍走统一 Dispatcher。容器只是后续部署包装，插件只用于未来可选通道，不负责跨项目的持久事实。

## 决策

1. 每个接入方持有独立、长随机 Bearer Token，配置在 owner-only Secret 文件。接入方只能给出有界事实（`source`、稳定 `id`、`type`、标题、正文、可选时间/优先级/故障键），不能选择邮箱、目标、域名或副作用。跨机器须通过 TLS 或受信加密网络。
2. `source + id` 有唯一约束，先将事实及规则快照在 SQLite 事务中持久化，再回复 202；同键不同内容是 409。未匹配或目标不可用仍保存为 `unrouted`。规则按来源与类型前缀、文件顺序首个命中，选一组公开目标别名；接入方不用知道内部 `ops` 领域。
3. 规则选中的目标只作为**服务端内部派发参数**传给 Dispatcher，不写入公共 `NotificationEnvelope v1`；目标别名不是设备密钥或邮箱地址。可选窗口合并需要上报方提供故障键，每条被合并的事实仍保留与原事件的关联。
4. 周期 Worker 领取 `pending`，逐目标 Action Journal 保护发送；崩溃中的 `sending` 转入 `uncertain`，不自动重放。明确失败可由 Operator 人工重试，未知结果不能自动重试。SMTP 使用 TLS、受限配置目标、纯文本正文、有界超时；无 Secret 时禁用邮件目标。
5. 不新增 Web 界面。Operator 用受保护 HTTP 查询事件、手工重试；原项目自身的备份成功/失败判断不等待通知送达。要求上游“保证上报”时，上游须自有 outbox，不把通知 Worker 纳入备份事务。

## 后果与拆分条件

目前仍由单个 Gateway 及其 SQLite/Action Journal 保持唯一可写状态；配置在启动时加载。以后只有在多机独立发布、流量或故障域确有需求时，才将收件箱 + Worker + 目标/通道适配 + 所需状态/Secret 整体搬到单独进程或容器，并让原 Gateway 通过同一 HTTP 契约访问；不能运行两个共享数据目录的写入 Worker。跨机切换先停写或在线备份，再原子切流，避免两端分别接受同一 `source + id`。当前不实现配置热更新、自动重投未路由事件、真实 SMTP 验收或独立容器。

操作格式与例子见 [统一通知平台](../notification-platform.md)。
