# ADR-0002：驻扎地与持续任务入口

- 状态：Accepted
- 日期：2026-07-10

## 背景

当前 Web Playground 把一次任务表现为填写完整表单后发布一个独立 Run。这适合验证 Runtime，却不符合长期使用心智：用户期待部落长期驻扎在一台服务器上，平时保持可用，工作、研究或 Coding 任务出现时可以自然交给部落，并在过程中追加信息、调整目标或审批动作。

Workspace 仍然重要，但不应成为每次发任务前必须理解的技术参数。用户需要的是一个稳定的“驻扎地”，其中保存部落、常用工作地、任务历史、资产和成长记录。

## 决策

引入 `Settlement`（驻扎地）作为长期运行边界：

```text
Settlement
├─ Tribe roster and governance
├─ Workplaces
│  └─ repository / directory / remote context
├─ Inbox
│  └─ natural requests, follow-ups and approvals
├─ Missions
│  └─ durable intent and conversation
├─ Runs
│  └─ one bounded execution attempt
└─ Assets and member history
```

- **Inbox** 是默认入口。用户可以像交代事情一样输入目标，不必先选择工作流。
- **Workplace** 是可复用工作地点。首次选择目录后保存名称和边界，后续任务默认沿用，用户也可以发起不绑定项目的通用任务。
- **Mission** 表示持续目标，可包含多轮澄清、计划、执行、反馈和多个 Run。
- **Run** 仍是一次可审计、可计费、可失败重试的原子执行，不承担长期对话语义。
- 部落服务长期驻留，但模型不保持空闲会话或持续消耗 Token；任务到达时才唤起成员。

## 自然任务路由

用户只需表达意图，Task Intake 判断进入以下模式：

- `answer`：无需 Workspace 的直接讨论或建议。
- `inspect`：只读分析一个 Workplace。
- `change`：需要计划、工具权限和审批的 Coding/文件修改。
- `operate`：运行测试、部署或外部系统操作，需要更严格审批。
- `continue`：对现有 Mission 追加反馈或继续执行。

早期只开放 `inspect`。`change` 和 `operate` 必须等工具权限、Git 工作区保护、审批和回滚建立后启用，不能把自然语言直接映射为任意 Shell。

## 产品呈现

Web 从“任务发布表单”逐步演进为部落驻扎地：左侧是 Inbox/Missions/Workplaces，中间是当前任务对话与活动，右侧是成员状态、预算、派工和审批。高级参数折叠为任务设置，普通用户默认只看到输入框和当前工作地。

## 后果

- Server 需要持久化 Mission、Workplace 和任务队列，不能只保留内存 Job。
- Runtime 继续保持无状态执行器，通过 Mission 上下文生成一次 Run。
- 需要明确区分“服务在线”和“模型正在调用”，长期驻留不等于持续烧 Token。
- 当前 Web Playground 作为过渡版本保留，下一阶段先增加任务历史和活动可见性，再重构为 Inbox。
