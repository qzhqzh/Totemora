# ADR-0021：同仓维护、独立部署的 Notifier

状态：Accepted。对 [ADR-0020](0020-cross-project-notification-ingress.md) 的“先在 Gateway 内运行、以后再决定是否拆分”作部署方向的 Supersedes；保留 ADR-0020 的事件契约、未路由留痕和未知结果不重发约束。[ADR-0018](0018-unified-notification-platform.md) 的领域筛选和逐目标幂等不变。

## 背景

后续一体机可能组合多个独立业务应用，各应用只应报告事实，不能各自维护 SMTP 凭据和邮件投递逻辑。原先 Gateway 内嵌通知发送器依赖其 `totemora.db`、Bark/Telegram 服务与周期 Runner，无法按客户单独升级和复用。多镜像的代价来自进程常驻、持久状态、协调与连接开销，不取决于镜像文件个数本身；通知应是一个粗粒度组件，而非每个通道一个微服务。

## 决策

1. 在同仓新增 `packages/notifier`，由它独立提供 HTTP 事件收件箱、目标配置与通道适配、Worker、`notifier.db` 和逐目标 Action Journal。其运行时不能 import `packages/server`。依赖方向 `@totemora/server → @totemora/notifier`，使用方以 HTTP 交互；不增加 Gateway→Notifier 数据库共享。
2. 每台客户设备单实例 Notifier。Totemora 使用其 HTTP 客户端；旧 `/api/integrations/notifications/events` 与 Operator 查询/重试由 Gateway 鉴权或转发，跨项目也可直接连接独立服务。只为业务客户端提供事实接收契约，目标 ID/Secret 由 Notifier 私有配置持有。
3. 一份 `Dockerfile.notifier`、一份可组合的 `compose.notifier.yaml`，独立版本/数据挂载/配置/升级；Bark、ntfy 可以是已有传输容器，但发送决策/账本仍只在 Notifier。Python SDK 未来只作薄 HTTP client，不承载第二套通知策略或数据库。
4. 已持久接收返回 `202`，不保证用户已读；发送失败、网络结果不确定与未匹配规则都保留可检查的不同状态。内部同步信封使用 `POST /api/v1/dispatch` 与目标回执，网络结果未知不自动重试。服务间跨机 Bearer 必须走 HTTPS 或可信加密网络；默认端口仅向宿主机 loopback 暴露。
5. 旧 Gateway 的迁移记录不可删除或重写。离线导入器把已有收件箱与 `notification:*` Action Journal 拷到独立库，活动中的发送标为 `uncertain`；切换时先停旧发送进程，后搬私有配置、对账、启动 Notifier 和 Gateway。不允许两个 Writer 共享 SQLite 或同时从旧收件箱派发。
6. Notifier 同镜像提供独立 `/admin/` 管理页，不依赖 Totemora Web/Gateway。浏览器以私有 Operator Token 换短期 HttpOnly 会话，同源校验保护变更；操作员查看脱敏目标、管理 Bark/邮件/来源/规则、诊断事件与逐目标回执。原只读挂载继续提供初始化与 Telegram/ntfy 配置；管理页的改动按字段原子写入 Notifier 数据目录的私有 overlay，校验并即时替换运行配置，重启后恢复。完整 Secret 不通过查询 API 返回，管理页的“通道接受”不宣称终端已收到。

## 影响与边界

- 应用、镜像和数据库可以独立维护；一个客户升级无需重发其他业务镜像，但必须备份其 Notifier 状态、锁定兼容的 HTTP v1 契约并在维护窗口单实例滚动替换。
- Totemora 的业务领域/候选状态仍在 Gateway；Notifier 不复制这些状态或触发 AI/财经采集。Telegram Webhook 对话仍属于 Totemora 的交互资产。遗留 Bark 管理路径在使用独立 Notifier 时阻止写入；其旧配置不会暗中被当作新目标。
- 管理页的私有 overlay 与原始 ingress/targets 文件、`notifier.db` 都纳入备份/回滚集合；不能只回滚镜像或只恢复数据库。Telegram/ntfy 的管理仍在私有目标文件，页面只是只读观测/定向测试，不得伪装为可编辑的目标。
- 当前为本地开发交付；生产地址、真实 SMTP 密钥、历史数据实际切流、实时外发验收及跨机器 TLS 部署都需要按设备分别执行，不能因为代码与 Compose 存在就声称完成。

详见[统一通知平台](../notification-platform.md)。
