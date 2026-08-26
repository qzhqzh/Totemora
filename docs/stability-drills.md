# 稳定性故障演练

`bun run stability:drill` 在临时隔离目录中调用生产类边界，验证故障归因、隔离、持久恢复和熔断语义。演练不访问真实 Provider 或通知通道，不读取生产 Secret，也不修改现有 `.totemora` 业务状态。

```bash
bun run stability:drill
```

每次运行会在 `.totemora/stability-drills/` 写入同 ID 的 JSON 与 Markdown 回执。该目录属于本地运行数据，不提交到仓库。

## 固定场景

| 场景 | 生产类边界 | 验收事实 |
| --- | --- | --- |
| `provider-degradation` | `OpenAICompatibleProvider`、失败归因 | 上游 504 归为可重试 Provider 故障 |
| `recurring-isolation-and-restart` | `RecurringServiceRunner`、持久状态 Repository | 单服务失败不阻断健康服务；重启关闭悬空 `running` 状态并记为失败 |
| `gateway-task-restart` | Gateway App、JobStore、SpecialistTaskRepository | 中断的 Development 任务和统一任务信封共同收敛为可重试失败 |
| `bark-circuit-breaker` | Bark 通知服务 | 三次失败后开路，下一次不调用外部通道，状态回执不泄露完整 device key |

针对性回归：

```bash
bun test scripts/run-stability-drills.test.ts
```

该演练证明的是本地故障语义和恢复契约，不证明真实 Provider、网络、GitHub 或 Bark 服务的可用性。真实外部系统演练必须另行确认目标、凭据、幂等键、费用和副作用权限。
