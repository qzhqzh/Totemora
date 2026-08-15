# Totemora Gateway 架构

## 目标

Totemora 常驻服务器，成员按任务唤醒。Web、MCP、Telegram、Cron、Webhook、IDE 和专业服务 CLI 都是 Gateway Adapter，不拥有独立 Runtime、成员历史或 Skill 状态。通用 CLI Run 目前仍是本地直连 Runtime 的兼容路径。

```text
Web / MCP / Telegram / Cron / Webhook / IDE / Gateway CLI
                         │
                         ▼
                Authorization + Intake
                         │
                         ▼
        Settlement -> Mission / SpecialistTask
                         │
                         ▼
       Chief Staffing / Durable Service Binding
             │                    │
             ▼                    ▼
       Member Workers       Governed Assets
             └──────> Review / Gates ──────┘
                         │
                         ▼
              Result + Evidence + Experience
```

## Totemora 自有领域

- Ember 与 Member 分离；
- Chief 的预算派工与长期专业委任；
- Workplace Policy；
- Mission、Run、SpecialistTask 和专业状态机；
- 专员自检、Chief 验收与按风险加入 Reviewer；
- 持久化 Skill Commission、包版本、独立试炼、成员装备和效果证据；
- 失败归因、成员经历、画像与受控成长。

入口 Adapter 只能创建命令、查询状态和接收结果，不能绕过这些领域直接调用模型、Shell 或外部系统。

## 当前实现边界

- Gateway：Bun HTTP 常驻服务，Web 静态资源与 JSON API 同源。
- 状态：`.totemora/totemora.db` 使用 SQLite WAL；不可变 Run 证据、Secrets、Operator Token 和静态资产目录保留为文件。
- Web：任务大厅、证据台、成员营帐、火种、资产、AI / 财经双域情报台、内容工坊与治理审批。
- CLI：配置、Provider 检查和通用 Run 仍本地直连；Gateway 管理和专业任务命令调用常驻 Gateway。
- MCP：Streamable HTTP `/mcp` 与 stdio bridge，暴露结果导向的专业服务，不暴露任意 prompt 或 Shell。
- Telegram/Bark：受控通知、命令与反馈通道，不创建第二份情报队列。
- 通用 Run：只读 Workspace 分析。
- 受控副作用：Git Flow 可处理已有改动的 Commit、Issue、Push、PR、Review 和 Merge；情报通知与内容生成使用各自资产、幂等和发布门禁。
- 认证：所有状态变更、模型调用、取消、重试、外部动作和治理批准使用 Operator Token 或通道 allowlist。

## 专业服务与资产

专业服务向调用方暴露一个长期结果目标，内部由 Chief 路由给专员。每次执行形成 `SpecialistTask`；服务定义、长期绑定和单次任务分离。Git、AI 情报、财经情报和内容各自拥有状态机，统一任务信封、事件、幂等、恢复、验收和经验信用。财经垂直作为首个新增样本，验证了新成员可复用候选、派发、资产和成长内核，同时保留自己的证据等级和风险门禁。

确定性执行器属于部落资产，不属于成员。`assets/tool-assets.json` 保存图纸、动作、风险和授权；动作账本记录成员、工作流、幂等键、结果和证据。Skill 说明如何判断和工作，资产执行受控动作，专业服务提供稳定契约。

## 当前设计：对话式 Skill Commission

聊天入口不接收上传包。用户描述能力或提供参考来源后，Adapter 将消息交给同一 Gateway；Chief 创建持久 Commission，组织澄清、起草、验证、试用和激活 Proposal。Web 与 MCP 只负责承载对话和展示状态。

Skill 激活不能暗中获得资产、Secrets、Shell、人格或模型权限。完整设计见 [Skill 对话治理](skill-governance.md) 与 [ADR-0016](adr/0016-conversational-skill-governance.md)。

## Hermes 借鉴

Totemora 继续借鉴 Hermes 的平台无关核心、多入口 Gateway、Fresh Session 路由、可中断执行、隔离 Cron 和入口授权，但不采用“一个长期 Agent”作为核心领域。

来源：

- [Hermes Architecture](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/architecture.md)
- [Hermes Messaging Gateway](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)
- [Hermes Cron](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md)
- [Hermes Security](https://github.com/NousResearch/hermes-agent/security)

当前没有直接复制 Hermes 源码。若未来复制其 MIT 代码，必须保留原版权与许可证，并在 `THIRD_PARTY_NOTICES.md` 标注文件、原始版本和本地修改。

## 下一步

1. 统一专业任务进度事件、取消与异步批准；
2. 为命令资产补统一 policy hooks 和进程级 sandbox；
3. 在证据台完善服务恢复、Skill 试用与版本效果窗口；
4. 云端阶段再增加租户、OAuth、配额、计费和公开市场。
