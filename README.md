# Totemora

Totemora 是一个受预算和证据约束的异构多 Agent 组织系统。它把基础模型、人格、Skill、资产授权和经历组合成可持续验证的成员，由 Chief 在质量、成本和时延边界内组队、验收并保留运行证据。

项目采用 `TUI-first + Web Observatory`：CLI/TUI 是开发者控制入口，Web 承载观测、案卷和显式审批，MCP 向外部 Agent 暴露受治理的专业服务。

[查看交互式架构图](https://qzhqzh.github.io/Totemora/) · [仓库内当前版本（v2.15-r2）](docs/diagrams/totemora-architecture.html)

## Quickstart

```bash
bun install
bun run start:web
```

默认 Web Gateway 监听 `http://127.0.0.1:4310`。首次启动会在 `.totemora/operator-token` 生成本地操作员 Token。完整配置、CLI 和 MCP 用法见 [Quickstart](docs/quickstart.md)。

## Documentation

- [文档导航与当前产品事实](docs/README.md)
- [领域架构](docs/architecture-v2.md)
- [Gateway 架构](docs/gateway-architecture.md)
- [Codex 任务监督器](docs/codex-supervisor.md)
- [Codex 定时任务定向投递 Telegram](docs/codex-supervisor.md#定时任务定向投递)
- [Bark / Telegram / ntfy 统一通知平台](docs/notification-platform.md)
- [事项提醒与旧 memo 迁移](docs/reminders.md)
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
