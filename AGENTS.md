# Totemora Agent Engineering Guide

本文件是 Totemora 仓库级工程契约，适用于所有人类与 AI Agent。目标是让多个 Agent 在共享工作区中并行工作时，仍能保持清晰的架构边界、文件所有权和可验证结果。

## 1. 规则优先级

1. 当前用户明确指令。
2. 本文件、相关 ADR 和当前代码/测试所表达的真实契约。
3. `docs/execution-plan.md`、版本测试指南和历史项目记忆。
4. 通用偏好。

代码、测试和文档冲突时，不要猜。先指出冲突；行为以测试和已上线兼容性为准，架构方向以 ADR 和本文件为准，并在同一变更中修正文档漂移。

## 2. 不可破坏的产品与领域边界

- Totemora 是受预算和证据约束的异构多 Agent 组织，不是任意 Prompt、Shell 或模型代理层。
- 保持 `TUI-first + Web Observatory`：TUI/CLI 是开发者控制入口；Web 优先承载观测、案卷和显式审批。
- Provider、Agent/Member、Role、Skill、Asset 和 Specialist Service 必须分离：
  - Provider 只描述和适配模型调用。
  - Member 组合模型、人格、角色、Skill、资产授权、经历和版本。
  - Skill 提供程序性指导，不自动获得工具、Secret 或外部副作用权限。
  - Asset 提供受治理的确定性能力。
  - Specialist Service 提供可持久化、可恢复、可验收的长期业务契约。
- 通用 Run 默认只读。文件写入、Shell、Git、通知、发布等副作用只能通过专用服务、Policy、资产授权、幂等记录和显式门禁发生。
- Web、MCP、Telegram、Cron、Webhook、IDE 和 CLI Adapter 不拥有第二套 Runtime 或状态真源。
- SQLite 是 Gateway 可变业务状态的真源；不可变 Run trace、Operator Token、Secret 和静态资产按现有文件契约保存。

权威设计入口：

- `docs/architecture-v2.md`：领域模型和运行循环。
- `docs/gateway-architecture.md`：Gateway 与 Adapter 边界。
- `docs/skill-governance.md` 与 `docs/adr/0016-conversational-skill-governance.md`：Skill 生命周期。
- `docs/execution-plan.md`：当前路线和已完成能力。

## 3. Workspace 包职责与依赖方向

允许的依赖方向：

```text
core ← providers
core ← mcp
core + providers + mcp ← server ← HTTP clients（Web / MCP client / TUI Gateway commands）
core + providers ← TUI local commands
```

箭头从“使用者”指向“被依赖者”。Web 没有 workspace import，只是 Server HTTP 的浏览器调用方。

具体规则：

- `packages/core`：配置模型、Provider 抽象、任务分析、部落运行时、只读 Workspace 和 Run 类型。不得导入其他 `@totemora/*` 包，不得包含 Gateway 路由、SQLite 业务表、通知或 Git 远端实现。
- `packages/providers`：模型与图像 Provider 适配和凭据解析。只依赖 Core 契约；不得包含成员选举、任务状态机或业务门禁。
- `packages/server`：Gateway composition、应用用例、领域服务、持久化和受治理集成。可以依赖 Core、Providers 和 MCP HTTP handler；业务模块不得反向泄漏到 Core。
- `packages/mcp`：MCP tool adapter 与 Gateway client。只通过 HTTP 契约调用 Gateway，不导入 Server 内部模块或直接访问 SQLite。
- `packages/tui`：CLI 参数、输出和本地兼容入口。Gateway 命令只调用 HTTP API；不得复制 Server 领域状态机。
- `packages/web`：浏览器 Adapter。只使用公开 HTTP API，不持有服务端真源，不在浏览器复制审批、幂等或权限判定。

Web 模块约定：

- `packages/web/src/app.js` 只负责路由识别、Feature 注册和启动编排，不放领域渲染或事件处理。
- `packages/web/src/features/<domain>.js` 拥有一个界面领域的本地状态、事件、渲染和 HTTP 调用；跨 Feature 调用只依赖其公开的 `*Feature` facade。
- `packages/web/src/shared/` 只放确实跨领域稳定复用的浏览器基础设施，例如 DOM 安全、操作员会话和应用上下文；不得演变成无归属工具箱。
- 新浏览器模块保持单层、kebab-case `.js` 命名；增加目录层级或其他资产类型时，同步更新 Server 静态资源 allowlist 和测试。

禁止形成 workspace 循环依赖。跨两个以上 Adapter 共享的 DTO/运行时 schema 应提取到无 Server 实现依赖的公共契约模块；不得在 `app.ts`、MCP client 和 Web 中分别维护不同枚举。

新增 workspace 包属于架构变更：需要 ADR、明确依赖方向、公开 exports、package manifest、workspace 检查和独立验证。

## 4. Server 内部分层标准

当前 `packages/server/src` 仍是平铺结构。后续新增能力或拆分热点文件时，逐步收敛到以下职责；不要做一次性大搬家：

```text
bootstrap/ or index.ts       进程启动、composition、scheduler wiring
http/                        route、auth、输入解析、状态码、response DTO
domains/<context>/           状态机、策略、领域类型和不变量
application/                 跨领域用例、任务编排、事务边界
repositories/                SQLite 映射和领域持久化接口
integrations/                Git、Bark、Telegram、Provider、文件和外部 HTTP
```

依赖只允许从外向内：Adapter/Integration → Application → Domain。Domain 不得导入 HTTP、MCP、Web DOM、Bun server 或外部客户端。

### 命名语义

- `*Service`：领域或应用用例，不是杂项函数集合。
- `*Repository` / `*Store`：持久化和查询，不负责模型调用或 HTTP 编排。
- `*Client` / `*Provider`：外部系统适配。
- `*Runner`：有明确生命周期的调度或后台循环。
- `*Handler` / `*Routes`：协议解析和响应映射。
- `CreateXInput`、`UpdateXInput`、`XResponse`：边界 DTO；不要用宽泛的 `Record<string, any>` 传播到领域层。

不要创建通用 `utils.ts`、`helpers.ts` 或 `common.ts` 垃圾桶。共享代码必须有清晰领域归属和单一变化原因。

## 5. HTTP、契约与权限

- Route handler 只做：匹配路由、认证、运行时输入校验、调用一个用例、映射状态码/响应。
- TypeScript `as SomeInput` 不是运行时校验。所有外部 JSON 必须验证枚举、必填字段、长度/数量、URL/path 和控制字符边界。
- 请求体和外部响应必须有大小上限；文件读取、网络读取和日志内容必须有界。
- 默认保护所有 mutation、模型调用、受保护证据和外部动作。公开只读接口必须是有意识的产品决定。
- 401、403、404、409、413、422/400 和 500 要保持语义，不要把所有异常压成 400。
- 外部副作用必须先取得幂等键或 lease，记录结果/不确定状态后才能重试；网络未知结果不得自动重放。
- Adapter 不得绕过 Commission、Reviewer、Chief 或 Operator 门禁直接修改 Skill、成员人格、资产授权或发布状态。
- API 变更默认向后兼容。破坏性契约需要版本方案、迁移说明和调用方同步测试。

## 6. 数据库与状态标准

- 新 schema 变更只能追加新的 migration version；不得删除或改写已经发布的 migration 语义。
- Migration 必须在单一事务中完成，重复启动安全，并带真实的 pre-upgrade fixture 测试。
- 迁移测试至少证明：旧数据保留/显式 supersede、ID/version 映射、约束生效、重复执行、失败时不留下半迁移状态。
- 不确定或非法历史数据优先隔离并保留证据，不得静默改成合法业务结论。
- 状态机枚举同时在应用入口和数据库约束层防守；不能只依赖 TypeScript union。
- 领域模块通过自己的 Repository/Store 访问数据。不要让新的服务到处直接写裸 SQL；跨领域查询应进入专用 read model 或 Observatory。
- `StateDatabase.open()` 负责连接、基础设施和 migration 调度，不应继续吸收领域业务规则。新增 migration 变多时，按版本拆到 `migrations/` 并由它顺序注册。
- Secret、Token、完整设备 key 和私有绝对路径不得进入普通表、响应、日志、测试快照或提交。

## 7. 文件规模与复杂度预算

行数是拆分信号，不替代设计判断；生成文件、纯数据和必要的协议清单可说明例外。

- 新生产代码文件目标不超过 300 行。
- 新文件或本次变更使文件超过 400 行：PR/交接中必须说明单一职责为何仍成立，并给出拆分点。
- 新文件或本次新增职责使文件超过 600 行：合并前必须拆分，除非 ADR 明确记录例外。现有 legacy hotspot 可做不增加职责的紧急小修，但新行为应优先局部提取。
- 测试文件目标不超过 500 行；超过 700 行应按领域或行为拆分。
- 单个函数目标不超过 60 行；超过 100 行必须拆解状态阶段或提取具名策略。
- 一个 route 文件目标不超过 15 个 endpoint；新增领域应拥有自己的 route module。

以下是当前 legacy hotspots，禁止继续加入新职责：

- `packages/server/src/app.ts`
- `packages/server/src/development-service.ts`
- `packages/core/src/runtime/tribe-runtime.ts`
- `packages/server/src/intelligence-service.ts`
- `packages/server/src/skill-commission-service.ts`
- `packages/server/src/bark-notification-service.ts`
- `packages/server/src/skill-registry-service.ts`
- `packages/server/src/content-studio-service.ts`
- `packages/tui/src/commands.ts`
- `packages/server/src/state-database.ts`

触碰 hotspot 时遵循“局部提取，不顺手重写”：

1. 先固定行为和针对性测试。
2. 将本次需要新增或高频冲突的职责提取到具名模块。
3. 保持旧入口为薄 facade/composition，避免同时重排无关代码。
4. 单独验证提取增量；不要把功能改动藏在大规模移动中。

Server 通过 `packages/server/src/web-assets.ts` 显式提供 Web 根资产和单层 `features/`、`shared/` JavaScript 模块。新增路径或资产类型必须同步扩展 allowlist 与 `web-assets.test.ts`，不得提交会在运行时 404 的浏览器 import。

## 8. 建议的热点拆分顺序

这是增量路线，不是要求当前任务一次完成：

1. `server/app.ts`：先按 `skills`、`members`、`intelligence`、`finance`、`content`、`development`、`runs` 提取 route modules 和输入 schema；composition 留在 App factory。
2. `web/app.js`：薄 bootstrap 和领域 Feature 基线已完成；后续保持该边界，按真实子领域拆分超过预算的 Feature，路由级懒加载另行评估。
3. `development-service.ts`：分为 Git Flow state machine、plan/review parser、local Git executor、remote GitHub client。
4. `tribe-runtime.ts`：分离 orchestration、prompt builders、response parsers/validators 和 review policy。
5. `state-database.ts`：迁移注册器与分版本 migration 文件分离；领域 SQL 继续下沉到 Store/Repository。
6. 其余领域服务：优先分离 source/client、domain decision、repository，避免为了行数机械切文件。

每一步都必须保持公共行为兼容，并可独立合并和回滚。

## 9. 多 Agent 协作协议

### 开始前

- 主 Agent 先读取 `git status`、当前分支、相关 ADR/测试和真实调用链。
- 把任务拆成可独立验收的功能单元，而不是按“前端/后端”模糊分工。
- 每个写入 Agent 的任务必须声明：目标、拥有文件、禁止触碰文件、验收命令。
- 多 Agent 共享同一工作区时，任何时刻一个文件只能有一个写入 owner。

### 高冲突文件

以下文件默认只能由主 Agent/集成 owner 修改：

- `package.json`、`bun.lock`、`tsconfig.json`
- `packages/server/src/app.ts`、`packages/server/src/state-database.ts`
- `packages/web/src/app.js`、`packages/web/src/index.html`、`packages/web/src/styles.css`
- workspace package manifests、barrel exports、共享 contract/schema
- 根 `AGENTS.md` 和架构 ADR

其他 Agent 可以对这些文件做只读分析并返回建议或 patch 片段；若确需写入，主 Agent 必须先明确转移 ownership。

### 共享工作区 Git 规则

- 子 Agent 不得自行 `switch/checkout` 分支、stash、reset、rebase、merge、clean 或删除文件；这些操作会影响所有 Agent。
- 未明确授权时，子 Agent 不 commit、push、开 PR 或 merge。
- 不得覆盖、格式化或恢复不在自己 ownership 内的改动。
- 发现重叠修改时立即停止写入，报告文件和 hunk，由集成 owner 决定顺序。
- 并行 reviewer 默认只读。高风险 review 固定 base/candidate SHA，分别检查 Standards、Spec 和触发的安全/数据/兼容专项。

### Agent 交接格式

每个写入 Agent 完成时必须报告：

```text
Outcome: 完成 / 阻塞
Owned files: 实际修改文件
Behavior: 改变了什么，未改变什么
Verification: 命令与结果
Risks / follow-ups: 剩余风险或无
```

集成 owner 必须复核 diff 和测试，不能仅凭 Agent 自述合并。

## 10. 变更与验证矩阵

所有改动先跑 `git diff --check`，再按风险选择：

| 变更 | 最低验证 |
| --- | --- |
| 纯文档 / AGENTS / ADR | `git diff --check` + `bun run docs:check`，核对路径、命令和当前代码事实 |
| TypeScript 局部逻辑 | 针对性 `bun test <files>` + `bun run typecheck` |
| Workspace/package 边界 | `bun run lint` + `bun run typecheck` + 相关 import/启动测试 |
| Web JS/CSS/HTML | `bun run --cwd packages/web check` + 真实浏览器渲染/截图；涉及 API 时加 Server test |
| Route/API | handler 测试覆盖 auth、无效输入、成功、领域冲突和状态码 |
| SQLite/migration | pre-upgrade fixture、重复迁移、非法数据、回滚/隔离语义 + 相关服务测试 |
| 外部副作用/并发 | 幂等、重试、未知结果、lease/fencing、部分失败测试 |
| 跨包或高风险候选 | 上述针对性验证 + `bun test` + 独立 review |

当前 `bun run lint` 只是 workspace manifest smoke check，不是完整 ESLint/静态规则检查；不得把它单独描述为代码质量已验证。`tsconfig.json` 只覆盖 TypeScript，Web 必须单独 bundle check。

测试与实现默认同目录、同 basename。修 Bug 时先写能复现的回归测试；迁移和状态机变化必须测试旧状态，不只测试新建数据库的 happy path。

## 11. Git 与交付

- 仓库采用 mainline：`main` 是唯一长期分支，开发从最新 `main` 创建 `feat/*`、`fix/*`、`chore/*` 或 `codex/*` 短分支。
- 不直接在 `main` 开发或 push。使用 Conventional Commits，通过 PR 合并。
- commit、push、PR、merge、release 和 deploy 是独立权限；不得根据其中一个授权扩大范围。
- 一个 PR 对应一个可独立评审的目标。多个功能单元要在 review/验证记录中分开说明。
- 合并前记录 base SHA、candidate SHA、review tier 和完成的检查；candidate 变化后只复审增量，base 前进后检查 integration delta。
- 不删除 migration、数据库、volume、用户文件或未确认来源的工作区改动。

## 12. Definition of Done

任务只有同时满足以下条件才算完成：

- 行为满足用户目标和现有兼容契约，没有未说明的 scope expansion。
- 依赖方向、领域边界、权限和单一真源没有被破坏。
- 新外部输入有运行时边界，新副作用有授权与幂等证据，新状态有持久化/恢复语义。
- 相关测试、类型检查和真实渲染按矩阵通过；已知环境限制被单独复验并明确说明。
- 文档、示例配置和 API 调用方与实现同步。
- diff 只包含本任务需要的行，用户和其他 Agent 的工作完整保留。
- 交接说明包含实际文件、验证结果、风险和下一步；没有把“后续可做”伪装成已完成。
