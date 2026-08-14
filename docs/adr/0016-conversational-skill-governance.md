# ADR-0016：通过部落对话治理 Skill

- 状态：Accepted（Git 专业服务已完成首个实现闭环）
- 日期：2026-08-11

## 背景

文件上传式“导入 Skill”要求用户理解目录、格式和依赖，也会把部落退化成一个 Skill 管理器。用户真正想表达的是“我需要一种能力”“这个方法值得让某个成员学习”或“这个成员应根据近期失败改进”，这些意图天然属于对话、委任和验收。

现有 `git-change-management` 已能在真实 Git Flow 后提出经验规则、批准 overlay 并递增版本，但它是单一专业服务的过渡实现：没有通用 Skill 委任、来源 provenance、正反例、试用期、装备 Proposal 和版本效果比较。

## 决策

Skill 管理采用**对话入口、规范化产物、证据治理**：

1. 用户通过任意受信聊天入口描述能力目标或提供 URL、仓库路径、既有 Skill 名称；不提供文件上传入口。
2. Chief 将创建持久 `SkillCommission`，负责澄清触发条件、边界、目标成员、所需资产、风险和验收例子。
3. Chief 可委任合适成员调研、起草和测试；用户不需要直接编辑文件。
4. 后台把成果规范化为 `SKILL.md`、Totemora `skill.yaml` 及按需的 `agents/`、`scripts/`、`references/`、`assets/`。
5. Skill 经 `discovering -> draft -> validating -> trial -> active` 生命周期管理；暂停、回滚和退役保留历史证据。
6. 当前 Run 固定 Skill 版本号；目标实现再固定包 digest。版本效果通过真实任务验收、成本、时延和失败归因比较，不能由模型自述。
7. Skill 激活与成员装备是独立 Proposal；工具、Secrets、资产动作、人格和模型权限继续由各自治理边界控制。

## 自治与门禁

Chief 可以在现有权限内自动调研公开来源、起草、静态校验和安排无副作用 trial。新增第三方执行代码、写权限、Secrets、外部副作用、人格变化或高风险正式激活必须显式批准。

低风险只读 Skill 可由驻地 Policy 允许在达到规定试用次数和验收率后自动晋级，但仍写入可审计、可回滚记录。默认 Policy 不启用自动正式激活。

## 方案比较

### 上传 Skill 包

实现简单，但把格式负担和安全判断推给用户，也无法自然表达“先研究、再试用”。不采用。

### 聊天后直接改成员提示词

体验自然，但不可版本化、不可测试，权限变化容易藏在提示词里。不采用。

### 对话形成 Commission，再生成治理包

保留自然交互，同时获得来源、结构、测试、版本、装备和回滚证据。采用。

## 后果

- 实现后，Web、Telegram、MCP 等入口将复用同一 Commission，不各自实现 Skill 上传或管理状态。
- 成员可以提出改进，但不能批准自己的活动版本或权限。
- 现有 Git Skill overlay 保持兼容，后续迁移为通用版本 Proposal，不继续复制同类专用 Store。
- “用户交给部落一个 Skill”在产品文案中改为“用户委任部落学习一种能力”。

完整规范见 [Skill 对话治理](../skill-governance.md)。

## 2026-08-12 实现记录

- Commission、消息、规范包、试炼和活动版本已进入 SQLite；Web 与 MCP 复用同一案卷。
- 包 digest 不随 draft / validated / active 生命周期标签变化，旧任务按实际加载 digest 留证。
- Git Flow 可通过 `trial_commission_id` 临时加载 validated 包；这不改变活动版本。
- 试炼只接受结构化专业任务证据：目标成员、专业服务、Reviewer、Commission ID、验收、Token 与耗时必须相符，手填指标不再算证据。
- 三次通过只允许进入 `activation_proposed`；高风险正式装备和回滚仍要求操作员显式动作。
- 通用文件包导出、脚本沙箱、非 Git 试用适配器与 Telegram Commission 入口尚未实现。
