# Totemora

Totemora 是个人 AI 生态中的常驻专业助手与消息沟通服务。它持续关注明确委托的事项，把项目情报转为有来源的行动建议，通过多种渠道传递结果、接收反馈，并保存采纳决定与运行证据。

项目保留预算、成员、Skill、资产授权和验收内核。CLI/TUI 承载开发者控制，Web 承载观测、建议与审批，Telegram 提供受限双向交互；Bark、ntfy、Telegram 和邮件由独立 Notifier 承接受控投递。各通道必须实际配置后才可用。

[查看交互式架构图](https://qzhqzh.github.io/Totemora/) · [仓库内当前版本（v2.15-r2）](docs/diagrams/totemora-architecture.html)

## Quickstart

```bash
bun install
bun run start:web
```

默认 Web Gateway 监听 `http://127.0.0.1:4310`。首次启动会在 `.totemora/operator-token` 生成本地操作员 Token。完整配置、CLI 和 MCP 用法见 [Quickstart](docs/quickstart.md)。

## Documentation

- [文档导航与当前产品事实](docs/README.md)
- [服务定位、能力清单与重启边界](docs/service-relaunch.md)
- [项目情报、行动建议与采纳流程](docs/project-radar.md)
- [领域架构](docs/architecture-v2.md)
- [Gateway 架构](docs/gateway-architecture.md)
- [Codex 任务监督器](docs/codex-supervisor.md)
- [Codex 定时任务定向投递 Telegram](docs/codex-supervisor.md#定时任务定向投递)
- [Bark / Telegram / ntfy 统一通知平台](docs/notification-platform.md)
- [事项提醒与旧 memo 迁移](docs/reminders.md)
- [优惠雷达与旧 deals 迁移](docs/deals.md)
- [指定 ntfy 消息转发与旧 history 迁移](docs/forwarded-relay.md)
- [通知项目整合、退役与归档回执](docs/notice-consolidation.md)
- [当前推进计划](docs/execution-plan.md)
- [收益基准与稳定性演练](docs/benchmark.md)
- [JSON 到 SQLite 升级指南](docs/storage-migration.md)
- [架构决策记录](docs/adr/README.md)
- [仓库工程与多 Agent 协作规范](AGENTS.md)

## Verification

```bash
bun run docs:check
bun run typecheck
bun test
bun run stability:drill
```

`bun run lint` 当前只是 workspace manifest smoke check，不代表完整静态代码检查。
`bun run benchmark:e5` 会把固定测试样本发送给配置的模型并产生费用，执行前必须确认 Provider、数据外发边界和预算。
