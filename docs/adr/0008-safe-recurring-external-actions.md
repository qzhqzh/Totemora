# ADR-0008：安全的常驻任务与外部副作用

- 状态：Accepted
- 日期：2026-07-14

> 情报扫描频率、候选池与节流派发已经由 [ADR-0009](0009-intelligence-candidate-pipeline.md) 取代；本 ADR 继续约束所有外部副作用的安全边界。

## 决策

定时任务不是无限自治 Agent。每个外部副作用必须同时满足：资产授权、显式动作、域名/协议白名单、Secret 隔离、超时和响应大小限制、幂等键、动作日志与有界证据。

`ActionJournal` 在执行前写入 `executing`，成功后写 `completed`，失败写 `failed`；相同幂等键的已完成动作不得再次执行，不同请求不得复用同一键。这样客户端超时、Gateway 重启或调度器重复 Tick 不会默默重复推送。

## 情报员纵向案例

- “听风”由 Qwen 火种孵化，处于 probation，导师是“深思”。
- `news-intelligence` 资产只允许 HTTPS 白名单信息源；通知端点遵循
  [ADR-0012](0012-internal-bark-and-feedback-loop.md)，优先使用 localhost 或 HTTPS 的自建 Bark。
- Bark server URL、device key 与 Basic Auth 分离，只从环境变量或
  `.totemora/secrets` 读取，不进入仓库、成员提示词或运行证据。
- 调度器每分钟检查一次，但同一小时最多产生一次定时情报；手动测试由 Operator 门禁触发，可发送 1–5 条。
- 收集、汇总、推送、成功和失败都进入资产证据与成员经历。

## 安全边界

动作日志解决重复副作用和可追溯性，不等于 OS sandbox。Gateway 仍需后续加入统一命令 Policy hooks、工作目录隔离、进程级 sandbox 和网络出口策略。Git Flow Engine 目前保留自身的状态机和三阶段门禁，逐步迁入统一动作协议。
