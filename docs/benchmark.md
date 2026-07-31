# 部落收益实验

Totemora 的 benchmark 参考 Inspect 的 `dataset / solver / scorer / log` 分层，以及
SWE-bench 的固定任务实例和独立评测产物，但不引入它们作为运行时依赖。

当前入口对同一任务、Workspace 快照和验收标准依次运行：

1. `single_strong`：指定强成员独立完成；
2. `single_cheap`：指定廉价成员独立完成；
3. `tribe`：由指定 Chief 进行派工、执行和复核。

任务之间采用固定轮换顺序，而不是永远先跑强模型，以降低 Provider 缓存、限流和时段
变化造成的顺序偏差；具体执行顺序保留在结果数组中。

运行首批 3 个烟雾任务：

```bash
bun run totemora benchmark run \
  --suite benchmarks/read-only-smoke.json \
  --strong-member deepseek_reasoner \
  --cheap-member qwen_worker \
  --chief deepseek_reasoner \
  --config-dir configs/example \
  --data-dir .totemora
```

默认所有策略的单次输出上限统一为 `2000` Token；需要改变时显式传
`--max-output-tokens <n>`，结果文件会固化实际预算。

该命令会产生真实 Provider 调用：每个任务包含 2 次单模型执行，以及一次可能包含
规划、成员执行和复核的部落 Run。先运行 `providers doctor`，并确认额度和预算后再执行。

结果写入 `.totemora/benchmarks/` 的 JSON 与 Markdown 文件，汇总结构通过率、总 Token、
强模型火种 Token、时延和失败数。火种按 `provider + model` 归类，而不是按成员名字；
同一火种塑造出的不同成员会计入同一类消耗。价格没有配置时明确记录为
`unconfigured`，不伪造成本。

## 当前评分边界

v1 scorer 是确定性的：检查每条验收标准是否逐字出现在 `acceptance_review` 且通过，
检查 `findings.evidence` 是否引用任务声明的证据路径，并可用 `required_claims` /
`forbidden_claims` 核对必须出现或不得出现的断言。它适合验证只读证据报告的结构和
可追溯性，所以指标明确叫 `structural_pass_rate`，不等于验证所有业务结论正确。

计量通过 Provider 外层记录每次尝试；即使模型返回了坏 JSON，已经报告的 Token 也会
保留。Provider 未返回 usage 时，结果标记 `partial` 或 `unknown`，此时数值 `0` 不能
解释为零消耗。

下一步应扩展到 10–20 个任务，并为代码变更类任务增加隔离环境中的测试 scorer；
模型评分只能作为补充，不能替代确定性验收。
