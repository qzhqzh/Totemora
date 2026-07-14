# Totemora Gateway 架构

## 目标

Totemora 常驻服务器，模型按任务唤醒。Web、CLI、聊天、Cron、Webhook 和 IDE 都是入口 Adapter，不拥有独立 Runtime 或独立部落状态。

```text
Web / CLI / Chat / Cron / Webhook / IDE
                 │
                 ▼
        Authorization + Intake
                 │
                 ▼
Settlement -> Mission -> Durable Job -> Chief Staffing
                                      -> Member Worker
                                      -> Specialist self-check / optional risk reviewer
                                      -> Delivery + Experience
```

## Hermes 借鉴

以下设计来自对 Hermes Agent 官方实现和文档的研究：

- 平台无关核心和多入口 Gateway；
- Fresh Session 与 Session 路由；
- 可中断 Provider/Tool 执行；
- Cron 每次创建隔离执行并将结果投递回来源；
- 不同平台使用不同 Toolset；
- 网络入口必须授权，Session ID 不能代替身份；
- 重启中断状态显式记录并允许恢复。

来源：

- [Hermes Architecture](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/architecture.md)
- [Hermes Messaging Gateway](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)
- [Hermes Cron](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md)
- [Hermes Security](https://github.com/NousResearch/hermes-agent/security)

当前没有直接复制 Hermes 源码。若未来复制其 MIT 代码，必须保留原版权与许可证，并在 `THIRD_PARTY_NOTICES.md` 标注文件、原始版本和本地修改。

## Totemora 自有领域

Hermes 的主抽象是一个长期 Agent；Totemora 必须保留以下自有领域：

- Ember 与 Member 分离；
- Chief 预算派工；
- Workplace Policy；
- Mission 与原子 Run；
- 专员自检、Chief 验收与按风险动态增加的 Reviewer；
- 失败归因；
- 成员验证经验与成长提案。

入口 Adapter 只能创建命令和接收结果，不能绕过这些领域直接调用模型或 Shell。

## 当前 v0.3 边界

- Gateway：Bun HTTP 常驻服务。
- Web：任务大厅、部落观察和开发提交审批。
- CLI：Gateway 管理客户端，不创建第二份开发 Runtime。
- 认证：开发写操作使用驻扎地 Operator Token。
- 可执行 Change：仅提交已有代码改动。
- 尚未开放：模型写代码、任意 Shell、push、部署和外部系统操作。

## v0.4 MCP Adapter

MCP 已作为第一个平台无关 Adapter 接入同一 Gateway，提供 Streamable HTTP `/mcp` 和本地 stdio bridge。第一项可发现能力是持久 Git Flow；调用方只委托目标，内部复用 Workplace Policy、Chief 能力路由、专员自检、阶段门禁、真实 PR Diff 与经验回写。MCP 不直接创建第二个 Runtime，详细契约见 [MCP Gateway](mcp-gateway.md) 与 [ADR-0005](adr/0005-mcp-specialist-service.md)。

## 部落资产层

确定性执行器属于部落，不属于某个成员。`assets/tool-assets.json` 保存资产图纸，成员配置授予使用权；执行器在每个动作前再次校验授权，并把成员、工作流、动作、结果和证据写入资产审计。Skill 是工作规范，资产是可执行能力，两者都不能绕过 Workplace Policy 和阶段门禁。详见 [ADR-0006](adr/0006-tribe-tool-assets.md)。
