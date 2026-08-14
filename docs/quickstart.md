# Quickstart

Totemora 提供 Web Playground 和 CLI，所有命令从仓库根目录执行。

外部 AI 也可以通过 MCP 调用同一个常驻 Gateway。完整配置见 [mcp-gateway.md](mcp-gateway.md)。

注意：当前通用 `totemora run` 是本地直连 Runtime 的兼容路径；Web、MCP 与专业服务共享常驻 Gateway。

## 启动 Web Playground

安装依赖后运行：

```bash
bun install
bun run dev:web
```

首次启动会生成 `.totemora/operator-token`（权限 `0600`）。登记工作地、发起模型任务、取消、重试及开发门禁都需要把它粘贴到 Web 页头；纯状态和成员浏览保持只读。也可以通过 `TOTEMORA_OPERATOR_TOKEN` 显式提供。

浏览器打开：

```text
http://127.0.0.1:4310
```

页面使用流程：

1. 先看“部落证据台”：它汇总常驻专业服务、Chief 到专员的委任、Skill/资产装配、成员经历和最近反馈。输入操作员 Token 后可继续查看受保护的任务与资产动作。
2. 在“部落成员”“火种”和“人物图鉴”确认模型与人物状态；在“成员营帐”查看画像、经历、成长效果并与成员交谈。
3. 首次在“登记常用工作地”保存服务器上的项目目录；通用 Run 只能读取已登记工作地或其子目录。
4. 在“任务大厅”描述只读分析目标。默认创建新 Mission，也可以选择已有 Mission 继续此前目标；按需调整 Chief、验收标准和智能预算。
5. 在 Run 现场观察 planning、executing、reviewing 等阶段，并查看派工理由、报告、验收、Token 和 Trace。
6. 专业任务使用对应入口：已有代码改动走 Git Flow 门禁，AI / 技术与财经情报走“双域情报台”，协作写作与配图走“创作工坊”；不要把这些副作用隐含在通用 Run 文本里。

第二台 Bark 手机不需要再手改 JSON：在“双域情报台”的“通知设备”中填写设备
信息、选择 AI / 财经路由并发送测试。完整 device key 只写入服务器 Secret，保存后
即时生效；详细步骤见 [内部 Bark 通知通道](internal-bark.md)。

任务大厅会在提交前显示 Task Analyzer 判断的模式。通用 Run 当前执行 `inspect` 和绑定工作地的 `continue`；`change`、`operate` 和无工作地 `answer` 不会伪装成只读执行。受控变更、通知和内容生产由强类型专业服务承接。运行中的模型请求可以点击“取消 Run”中止。

Provider、预算、派工等临时错误被标记为可重试时，Web 会显示“重试 Run”。重试会创建新的 Run 并继续归入原 Mission。Job 与重试规格已持久化，服务重启后仍可重试；被重启中断的 Job 会转换成可重试失败。

Web 服务默认只监听本机 `127.0.0.1:4310`。它会产生真实模型调用，通用 Run 只读取已登记 Workspace，不修改文件或执行 Shell。不可变 Run 证据保存在 `.totemora/runs/`；Job、驻扎地、Workplace、Mission、专业任务、候选、反馈、成员经历和治理 Proposal 的活动状态写入 `.totemora/totemora.db`。

## 委任部落学习能力

Totemora 的目标交互不是上传 Skill 文件。用户应通过部落对话描述能力、提供参考链接或指出成员需要改进的地方，由 Chief 澄清后创建能力委任，再组织起草、校验、试用和装备。

输入操作员 Token 后，在 Web 的“能力议事”直接描述能力目标、参考 URL、目标成员和验收例子。Chief 会继续追问或形成持久草案；草案通过静态校验后进入试用，但不会自动装备或增加权限。

当前首个完整试用垂直是 `git-change-management`。打开 `/skills`，选择 Skill 后可浏览完整目录；输入 Operator Token 后点击文本文件可只读预览 `SKILL.md`、配置、脚本和参考资料。疑似 Secret、二进制、软链和超限文件不会返回正文。

当能力案卷进入“试用中”，在“让部落完成对照试炼”里选择已登记的 Git 工作地、试炼目标和独立 Reviewer。系统让同一名 Git 专员先形成无新 Skill 基线，再加载案卷固定 digest 形成试用计划；Reviewer 比较两份结果，Chief 门禁随后登记 Evidence ID、Token、耗时和结论。这个动作只形成 Git 计划，不会提交、Push 或 Merge。至少三次独立通过才能提议正式装备，批准与回滚仍需显式点击；原手工登记两份专业任务证据的方式保留在“高级”区域。完整边界见 [Skill 对话治理](skill-governance.md)。

可通过环境变量覆盖启动参数：

```bash
TOTEMORA_PORT=4320 \
TOTEMORA_CONFIG_DIR=configs/example \
TOTEMORA_DATA_DIR=.totemora \
bun run dev:web
```

如果只是检查配置而不想产生模型费用，先使用后面的 `providers list`、`agents list` 和 `tribe inspect` 命令。

## 配置来源

示例部落直接读取现有 Claude settings 文件，不复制其中的密钥：

| Provider | 配置来源 |
| --- | --- |
| GPT 5.5 | 项目根目录 `.env` 中的 `OPENAI_API_KEY` |
| Xiaomi MiMo | `~/.claude/settings.json` |
| DeepSeek | `~/.claude/settings.ds.json` |
| Qwen | `~/.claude/settings.qwen.json` |
| CPA 图片模型 | `~/star/infra/cpa/config.yaml` 中的本地 CPA 上游配置 |

`.env` 已被 Git 忽略。不要把真实密钥写入 `configs/`、源码或提交记录。

## 安装与检查

```bash
bun install
bun run typecheck
bun test
```

查看部落：

```bash
bun run totemora providers list --config-dir configs/example
bun run totemora agents list --config-dir configs/example
bun run totemora tribe inspect --config-dir configs/example
```

真实检查全部 Provider：

```bash
bun run totemora providers doctor --config-dir configs/example
```

该命令会产生少量真实模型调用。全部显示 `ready` 后再运行部落任务。

## 运行首个部落任务

```bash
bun run totemora run onboarding-exam \
  --config-dir configs/example \
  --data-dir .totemora
```

当前默认由 DeepSeek Chief 生成派工计划，Qwen、MiMo 成员完成工作包，随后由 DeepSeek Chief 汇编并验收恰好三道题。

每次运行也可以覆盖默认首领：

```bash
bun run totemora run onboarding-exam \
  --chief deepseek_reasoner \
  --config-dir configs/example \
  --data-dir .totemora
```

当 GPT API 恢复后，可将 `--chief` 改为 `gpt_chief`，并把该成员状态从 `inactive` 调整为 `trusted`。

命令行打印最终试卷，完整结构化记录保存在：

```text
.totemora/runs/<run_id>.json
```

## 运行通用真实任务 Demo

仓库包含一个只读订单折扣 Demo。运行：

```bash
bun run demo:tribe
```

等价的完整命令是：

```bash
bun run totemora run \
  "分析这个 demo 项目的订单折扣实现，找出与 README 业务规则不一致的风险，并给出有文件证据的改进建议，不修改文件" \
  --workspace examples/demo-project \
  --accept "逐条比较 README 业务规则与当前实现" \
  --accept "每个关键结论引用真实文件路径" \
  --accept "给出按优先级排序的改进建议" \
  --config-dir configs/example \
  --data-dir .totemora
```

当前通用任务只支持只读分析。Workspace 收集器会排除 `.env`、凭据文件、`.git`、`node_modules`、构建目录和历史 Run，并限制文件数、单文件大小和总上下文。

运行过程中会显示 `planning`、`executing`、`reviewing`、`repairing`（仅需要时）和 `completed` 阶段。最终输出同时包含 Run ID、模型调用数和 Token 汇总。

可选预算参数：

```text
--max-files <n>
--max-context-bytes <n>
--max-output-tokens <n>
```
