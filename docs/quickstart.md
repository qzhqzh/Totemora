# Quickstart

Totemora 提供 Web Playground 和 CLI，所有命令从仓库根目录执行。

外部 AI 也可以通过 MCP 调用同一个常驻 Gateway。完整配置见 [mcp-gateway.md](mcp-gateway.md)。

## 启动 Web Playground

安装依赖后运行：

```bash
bun install
bun run dev:web
```

首次启动会生成 `.totemora/operator-token`（权限 `0600`）。只读任务不需要它；保存开发规范、准备提交和批准提交时，需要把它粘贴到 Web 页头。也可以通过 `TOTEMORA_OPERATOR_TOKEN` 显式提供。

浏览器打开：

```text
http://127.0.0.1:4310
```

页面使用流程：

1. 在“部落成员”确认 DeepSeek 首领及 Qwen、MiMo 等成员状态。
   “火种”区域展示可用基础模型及其 Provider、状态和已孵化人物；“人物图鉴”展示火种与人格、Skills、角色结合后的成员。
2. 首次可在“登记常用工作地”保存服务器上的项目目录；临时体验也可保持 `examples/demo-project`。
3. 在“任务大厅”直接描述要做的事。默认创建新 Mission，也可以选择已有 Mission 继续此前目标。
4. 按需展开高级设置，调整 Chief、验收标准和智能预算，点击“召集部落”。
5. 在 Run 现场观察 planning、executing、reviewing 等阶段。
6. 查看每个成员的选择理由、最终报告、验收结果、Token 汇总和完整 Trace。

任务大厅会在提交前显示 Task Analyzer 判断的模式。当前可执行 `inspect` 和绑定工作地的 `continue`；`change`、`operate`、无工作地 `answer` 会明确显示尚未开放，不会伪装成只读任务执行。运行中的模型请求可以点击“取消 Run”中止。

Provider、预算、派工等临时错误被标记为可重试时，Web 会显示“重试 Run”。重试会创建新的 Run 并继续归入原 Mission。Job 与重试规格已持久化，服务重启后仍可重试；被重启中断的 Job 会转换成可重试失败。

Web 服务默认只监听本机 `127.0.0.1:4310`。它会产生真实模型调用，当前只读取 Workspace，不修改文件或执行 Shell。Run 保存在 `.totemora/runs/`，可恢复 Job 保存在 `.totemora/jobs/`，驻扎地、Workplace 和 Mission 保存在 `.totemora/settlement.json`。

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
