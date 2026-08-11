# ADR-0013：Telegram 是受控的双向部落通信资产

- 状态：Accepted
- 日期：2026-08-09

## 决策

Telegram Bot 作为 Bark 的并行通道接入统一候选派发器，而不是建立第二套情报任务。

- 外发单位是 `candidate × channel × target`，使用稳定幂等键和动作日志；
- 候选只有在全部已配置目标接受后才进入 `pushed`；部分成功后重试会跳过已完成目标；
- Bot token、群白名单和 Webhook secret 只从环境变量或 `.totemora/secrets/` 读取；
- Webhook 同时验证 Telegram secret header 与 chat ID 白名单；
- 保持 Group Privacy Mode，只处理命令和 Bot 消息上的 callback query；
- 反馈进入现有 `candidate_feedback` 和成员成长证据，不另建人格分支；
- 群命令只读。会触发代码、任务或外部状态变化的交互继续走 MCP/Web 既有门禁。

## 原因

Bark 适合个人即时提醒，Telegram 群适合多人共同看到部落状态并反馈。但“增加通道”不能
改变情报员的判断语义，也不能因为一个通道重试而重复打扰其他通道。Telegram 官方同时
要求 Webhook 与长轮询二选一，并提供 `secret_token` 请求头用于来源验证，因此生产环境
采用 Webhook，`getUpdates` 只用于首次发现群 ID。

## 暂不采用

- 不关闭群隐私模式监听所有聊天；
- 不把自由文本直接交给模型；
- 不允许群命令绕过 Operator Token、工作地策略或 Git 审批；
- 不用 Telegram message accepted 作为成员成长信用，只有用户按钮反馈才计入。
