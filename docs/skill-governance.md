# Skill 对话治理

Totemora 不把 Skill 的入口设计成上传文件。用户通过 Web、Telegram、MCP 或其他聊天入口描述想获得的能力、给出参考链接或指出现有成员的问题；Chief 负责把这段对话转成一项可追踪的**能力委任**，再组织成员完成调研、规范化、试用和验收。

## 用户怎样使用

用户可以直接说：

- “我经常要整理 Git 提交，把我的做法交给执简学习。”
- “研究这个仓库的发布流程，先整理成候选 Skill，不要执行外部操作。”
- “听风最近总把同一事件当新消息，请基于失败记录改进他的 Skill。”
- “让千工试用这套写作方法三次，有稳定收益再正式装备。”
- “回滚执简刚升级的版本。”

Chief 应先确认目标、触发方式、边界、目标成员和可验收例子。对话信息不足时继续追问，不要求用户理解目录结构、YAML 或 `SKILL.md`。

```text
自然语言委任 / URL / 仓库路径 / 现有能力问题
                         │
                         ▼
                 Chief 澄清与定界
                         │
                         ▼
        调研来源 -> 起草 Skill -> 独立校验 -> 受限试用
                         │
                         ▼
          证据提案 -> 批准或策略自动晋级 -> 装备成员
                         │
                         ▼
            真实任务观察 -> 修订 / 回滚 / 退役
```

文件是部落在后台维护的规范化产物，不是用户交互入口。

## 领域对象

### Skill Commission

一次对话形成一项持久能力委任，至少记录：

- 原始目标、来源引用和对话消息；
- Chief 的澄清问题与用户回答；
- 目标成员或专业服务；
- 风险、所需资产和权限变化；
- 正例、反例与验收标准；
- 当前阶段、负责人、Reviewer 和下一步。

Commission 不等于已安装 Skill，也不能直接授予工具权限。

### Skill Package

规范化目录为：

```text
skills/<skill-id>/
├── SKILL.md             # 必需：触发描述与核心工作方法
├── skill.yaml           # Totemora 治理、装备和证据清单
├── agents/openai.yaml   # 推荐：跨宿主的界面元数据
├── scripts/             # 可选：需要确定性的重复操作
├── references/          # 可选：按需加载的详细知识
└── assets/              # 可选：输出模板等不进入上下文的资源
```

`SKILL.md` 的 YAML frontmatter 只放 `name` 与 `description`。触发条件必须写进 `description`；正文保持精简，只保留模型不能自行推断的程序知识。详细规范放入 `references/`，反复重写或容易出错的步骤放入 `scripts/`。

`skill.yaml` 属于 Totemora 自有领域，记录：

- 稳定 ID、版本、状态、负责人和目标成员；
- 能力、所需部落资产、风险等级和批准策略；
- 来源 provenance、包 digest 和生成方式；
- 验收用例、试用结果、激活证据和可回滚版本。

Skill 说明“如何判断和工作”；资产提供可执行能力；专业服务提供长期状态机与稳定外部契约。三者不能互相替代。

## 生命周期

```text
discovering -> draft -> validating -> trial -> active
                  │          │          │
                  └------ rejected      ├-> suspended -> active
                                       └-> retired
```

- `discovering`：对话澄清，尚无可执行内容。
- `draft`：已形成规范化包，但任何成员都不会自动使用。
- `validating`：结构校验、静态安全检查和正反例测试。
- `trial`：固定成员在受限任务上试用，Run 固定记录 Skill 版本和 digest。
- `active`：通过门禁并装备给指定成员或服务。
- `suspended`：发现风险或退化，停止新任务使用但保留证据。
- `retired`：不再使用，历史 Run 仍能解析原版本。

修订、装备、卸载、晋级、暂停、回滚和退役都使用版本化 Proposal，不直接改活动版本。

## 自主管理边界

Chief 可以自动完成：

- 调研公开来源；
- 生成或整理 draft；
- 运行结构校验和无副作用评测；
- 在既有权限内安排沙箱化 trial；
- 根据真实失败提出修订或回滚建议。

以下变化默认需要用户批准，不能藏在 Skill 升级里：

- 新增写权限、Shell、Secrets 或外部系统访问；
- 安装或执行新的第三方代码资产；
- 自动发布、提交、合并、部署或付费调用；
- 改变成员人格、原则、红线、模型或谱系；
- 将高风险 Skill 从 trial 晋级为 active。

低风险、只读 Skill 是否可在满足最少试用次数和验收率后自动晋级，由驻地 Policy 决定；默认仍产生可撤销的晋级记录。

## 证据与效果

一个 Skill 的“变好”不能由成员自述。每个版本至少绑定：

- 来源与内容 digest；
- 结构校验结果；
- 正例、反例和边界用例；
- 试用成员、Run ID、验收结果、Token、时延和失败归因；
- 与上一活动版本或无 Skill 基线的比较；
- 装备、批准、暂停和回滚记录。

Git 专业任务现在固定成员 ID、Skill 版本、实际加载内容 digest 和 Commission ID；旧 Run 不重解释，新任务也不能静默继承候选版本的信任。其他专业服务仍需在各自试用适配器中补齐同样的证据字段。

## 当前实现与下一步

当前仓库已经具备：

- SQLite 中持久的 `SkillCommission`、消息、规范包、试炼与活动版本；
- Chief 将自然语言和用户明确给出的 HTTPS 来源整理为澄清问题或结构化草案；
- 风险、目标专业服务和资产授权的确定性门禁，来源不能由模型自行发明；
- Web“能力议事”和 MCP 创建、继续、读取入口；MCP 不暴露正式装备动作；
- `git-flow-release` 的无新 Skill 基线、validated 包隔离试用、三次独立验收、显式装备和回滚；Web 可让同一目标成员自动运行基线/试用，并交给另一名 Reviewer 比较；
- 稳定包 digest，以及专业任务中的实际加载版本、Commission、Token、时延和 Chief 验收证据；
- 原 Git overlay 继续兼容，活动通用包会叠加到既有基线，不破坏历史版本。
- Web 一级入口 `/skills`：从仓库 `skills/**/SKILL.md` 读取真实包，展示来源、相对路径、版本或 content hash、绑定、完整目录树、Doctor 结果及现有治理证据；文本文件可在受保护的只读预览器中查看，页面不会把数据库正文当作文件真源。
- 只读 Registry API：`GET /api/skills/registry` 列出允许根目录中的 Skill，`GET /api/skills/registry/:id` 按安全 ID 读取详情，`GET /api/skills/registry/:id/file?path=<relative-path>` 在 Operator Token 门禁后读取已扫描的安全文本。客户端不能提交任意服务器路径，API 也不返回项目绝对路径；二进制、疑似 Secret、软链和超限文件不能预览。
- 成员试炼 API：`POST /api/skills/commissions/:id/run-trial` 创建后台对照试炼，请求必须携带 8–128 字符的 `idempotency_key`；同一键只登记一次 Trial，输入不一致时拒绝复用。`GET /api/skills/trial-runs` 与 `GET /api/skills/trial-runs/:id` 查询阶段、通过或拒绝结论和证据。当前只适配 `git.flow`，运行结果同时进入 Skill 案卷与专业任务日志。
- Registry Doctor 当前检查 frontmatter 的 `name` / `description`、可选 `skill.yaml`、重复 ID、包外/损坏引用、符号链接、文件规模，以及 `.env`、密钥文件和无扩展名文本中的疑似 Secret；结果分为已装备、候选、需关注与不可用。

当前 Skill 根目录约定为：

```text
<project-root>/skills/<skill-id>/
```

Registry 对仓库内真实目录做有界、单航班扫描并计算 SHA-256，短暂复用只读结果以避免匿名请求放大磁盘读取；页面“重新扫描”可立即绕过普通缓存，但同类手动刷新仍受短冷却保护。`skills/` 根软链、包内软链、越界引用和私有绝对来源路径都会被拒绝或隐藏。SQLite 只用于关联 Commission、Trial、Activation 和 Overlay 状态。当前页面不执行 Git clone/update，也不会投影到 Codex、Claude 或 Cursor 的运行目录。

当前仍是首个垂直闭环，不等于任意 Skill 已能安全执行：后台先把规范包持久化为结构化 JSON 和生成的 `SKILL.md` 内容，尚未导出 Commission 的完整目录，也不运行 Commission 提供的脚本。文件浏览只读，自动试炼只调用既有 Git 专业服务的“形成计划”阶段。下一实现节点是：

1. Phase A：补齐更严格的 manifest 兼容矩阵、可复现正反例用例集和跨版本差异；第三方脚本只能在隔离沙箱运行。
2. Phase B：增加 Skill Binding 与可审计 Projection Plan，再把固定版本安全投影到 Codex、Claude、Cursor；激活与文件复制保持两个独立动作。
3. Phase C：把同一验证/试用契约接入内容、情报等非 Git 专业服务，并用真实任务观察退化、形成可审批回滚建议。
4. 后续再接 LogWood 候选晋级、Git 私有来源认证、跨机器同步与签名信任；这些均未进入当前实现。
