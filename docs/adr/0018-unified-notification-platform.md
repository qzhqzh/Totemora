# ADR-0018：统一通知平台与三通道迁移边界

状态：Accepted

## 背景

Totemora 已有 Bark 与 Telegram 通知，封存的 `notice-ntfy` 项目曾运行 ntfy 服务、六类 Topic、多个 Python worker 和独立历史面板。两套项目同时采集热点、财经并维护各自的调度、去重、健康和历史，会产生重复状态真源、双发风险和持续维护成本；但 ntfy 仍是已配置 iOS 客户端正在使用的有效传输通道，不能把“退役独立项目”误解为“删除 ntfy 通知能力”。

现有 `IntelligenceDomain` 只表达 AI 与财经候选，不能承载提醒、优惠、转发、内容草稿和运维状态。Bark 的目标配置也不应成为所有通知通道的公共领域模型。迁移需要先建立领域无关的通知契约，再逐项接管业务能力和数据。

## 决策

### 一个通知领域，三个传输通道

1. Totemora 建立版本化 `NotificationEnvelope v1`，领域为 `ai`、`finance`、`reminder`、`deals`、`forwarded`、`content`、`ops`。
2. 支持 `bark`、`telegram`、`ntfy` 三个并列通道。退役对象是旧项目中的重复 worker、调度、历史面板和状态真源，不是 ntfy 协议或现有 iOS 订阅。
3. `NotificationDomain` 与 `IntelligenceDomain` 分离。候选筛选仍属于各业务领域；通知信封只表达已经决定外发的内容和公共传输语义。
4. 信封可以限制目标通道，但不能携带 Bark device key、Telegram chat ID、ntfy 凭据或任意目标 ID。服务端目标策略根据领域和通道解析真实目的地。

### 每个目标独立确认

1. 每个目的地使用 `domain event/window + channel + public target alias` 派生独立幂等键，并通过 Action Journal 保存结果。
2. 已明确失败的目标可以单独重试；已完成目标直接返回持久化回执，不再次发送。
3. 网络断开、成功响应缺少可验证回执等结果标为 `uncertain`，阻止自动重放。只要一个目标不确定，聚合结果也保持 `uncertain`。
4. Bark、Telegram 或 ntfy 接受消息只表示传输服务接受，不表示用户已经阅读。
5. Secret 仅存在运行时配置或 Secret 边界，不能进入信封、普通数据库字段、Action Journal 请求、日志、Web 响应或 Agent Prompt。

### ntfy 兼容策略

迁移期间保留已有六个 Topic 的机器标识，避免要求手机立刻重新订阅：

| Totemora 领域 | ntfy Topic |
| --- | --- |
| `ai` | `hotspot` |
| `finance` | `finance` |
| `reminder` | `memo` |
| `deals` | `deals` |
| `forwarded` | `forwarded` |
| `content` | `x` |

`ops` 使用独立可选 Topic，不混入 `memo`。ntfy Adapter 保留标题、正文、优先级、tags、click 和 icon；通道限制导致无法传输的完整内容仍由 Totemora 历史与 Web Observatory 保存，不静默截断。

ntfy 目标只允许 HTTPS，或服务器本机 loopback HTTP；认证头只在请求时注入。网络失败和无法验证的成功响应采用不确定结果语义。稳定公网入口与 iOS 订阅继续保留，但其传输容器、认证数据库和运行声明已经归 Totemora Compose 管理；撤销域名或轮换凭据仍需要独立授权。

### 增量迁移，不复制第二套 Runtime

迁移以源项目封存提交 `d75fa2d` 作为行为与数据证据，但不复制 Python workers、独立 History Web 或其认证数据库。后续阶段依次完成：

1. 通知契约、目标路由和三通道 Adapter；此阶段不连接真实业务外发。
2. 可恢复调度窗口、领域偏好 Store 和可重复执行的 legacy importer。
3. 由 Totemora 现有财经、热点服务接管重叠能力，并补齐必要来源。
4. 新增 reminder、deals、forwarded relay 和周期内容任务等独有领域能力。
5. 使用 SQLite online backup 制作一致性源快照并先 dry-run 导入；通过离线 fixture、去重种子和验收环境比较结果，不恢复生产影子服务。
6. 每个领域完成后只启用 Totemora 外发；尚未迁移的领域明确保持不可用，不以重启旧 worker 作为长期回退。旧数据库只作为恢复档案保留。

独立 ntfy 仓库最终只作为可恢复封存证据。若继续保留 ntfy 传输服务，其运行声明和集成所有权归 Totemora 治理，但不得把旧 workers 和历史面板整体塞进 Totemora 形成第二套应用。

## 本次落地边界

第一批增量只新增纯领域契约、服务端目标策略、通用派发器，以及 Bark、Telegram、ntfy 三个薄 Adapter，并以测试固定三通道、逐目标幂等和未知结果行为。Bark Adapter 复用显式目标投递；Telegram Adapter 用公开别名解析运行时群 ID，群 ID 不进入信封和派发证据。该批增量不修改 `app.ts`、数据库 migration、现有 Bark/Telegram 服务、Web 或部署配置，也不会发送真实通知、停止旧 worker 或改变线上路由。

后续把现有 Bark/Telegram 实现接入统一 Adapter 时，应从 legacy hotspot 局部提取，保持旧 API 兼容；不得继续向超长服务追加 reminder、deals 或 relay 职责。

## Gateway 运行时接入检查点

后续增量已经把第一批基础层接入 Gateway；2026-08-30 又完成了运行归属切换：

- Bark 管理目标可显式声明七个通知领域；没有声明领域的既有目标继续默认 `ai`、`finance`，避免升级后突然扩大外发范围。
- Telegram 与 ntfy 目标从 owner-only Secret 文件加载。Telegram Chat ID 必须同时命中 Bot 白名单；Secret、Chat ID 和 device key 不进入状态响应或 Action Journal 请求。
- `GET /api/notifications/platform` 只返回公开目标别名与配置状态；`POST /api/notifications/platform/test` 只接受领域、通道和幂等键，并发送服务器生成的固定测试文本。
- Gateway 启动会验证目标文件、Telegram 白名单和 Adapter 配置；没有目标时保持 `unconfigured`，不会隐式连接旧 ntfy 或发送消息。
- `compose.bark.yaml` 现在由同一个 `totemora` Compose 项目管理 Bark 与 ntfy 传输容器；旧 `notice-ntfy` 的 workers、history、ntfy 及可选 `codex-reset` 容器已经全部停止并移除，源数据未删除。
- AI、财经继续由 Totemora 现有服务承担。reminder 已由 migration 12、独立 Repository/Application Service、Operator API、Web 案卷、周期 Runner 与可重复 SQLite 快照导入器接管。deals 已由 migration 13、受限 HTTPS source client、冻结小时窗口、来源健康账本、Web 案卷和全量历史去重种子接管；旧运行日志不导入主业务表。forwarded 已由 migration 14、owner-only 单源 Secret、有界 ntfy client、持久游标、重叠内容去重、Operator API/Web 案卷和可重复 history 快照导入器接管。周期内容在领域实现完成前保持显式未提供，不通过恢复旧项目填补空档。

运维格式和测试入口见 [统一通知平台](../notification-platform.md)。

## 未选择

- 不删除 ntfy 通道：保留公网入口、认证数据和现有 iOS Topic，但将传输运行时迁入 Totemora。
- 不把提醒和优惠伪装成 AI/财经：会污染领域偏好、反馈和历史语义。
- 不整体复制旧 Compose、workers 和 History Web：会把双系统永久化。
- 不运行生产影子项目：离线验证新实现；发现故障时修复 Totemora，不恢复旧 worker 形成双系统。
- 不只复制正在使用 WAL 的 `.db` 文件：可能得到不一致或缺失最近事务的数据。

## 结果

Totemora 是通知内容、领域路由、派发结果、传输运行声明和后续业务状态的唯一继续开发主线，同时保留 Bark、Telegram 与 ntfy 的用户选择。旧仓库仅保留源码、数据库与凭据位置作为恢复证据，不再运行容器。后续能力迁移使用离线快照、dry-run importer、去重种子和验收环境完成；生产故障在 Totemora 内修复，不再以旧项目双跑作为回退。
