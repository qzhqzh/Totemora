# 科研雷达方向接口

科研雷达是听风的可选来源。它只按显式配置且启用的研究方向查询论文元数据；没有启用方向时不访问科研来源，也不产生科研推送。

## 接口

### 读取方向

`GET /api/intelligence/research-directions` 是公开只读接口，返回当前完整配置：

```json
{
  "directions": [],
  "updated_at": "1970-01-01T00:00:00.000Z"
}
```

### 替换方向

`PUT /api/intelligence/research-directions` 需要 Operator Bearer Token。请求会原子替换整组方向，适合在确定方向数量后一次配置：

```json
{
  "directions": [
    {
      "id": "citrus",
      "name": "柑橘",
      "keywords": ["citrus", "Citrus sinensis"],
      "enabled": true
    },
    {
      "id": "banana",
      "name": "香蕉",
      "keywords": ["banana", "Musa acuminata"],
      "enabled": true
    }
  ]
}
```

方向数量可变，也可以提交空数组清空配置。边界如下：

- 最多 24 个方向；`id` 只能包含小写字母、数字和连字符，且不能重复。
- 每个方向需要 1–8 个关键词；单个关键词最多 100 字符，整组关键词合计最多 1200 字符。
- `enabled` 省略时默认为 `true`。停用方向会保留配置，但不会进入查询。

## 运行语义

科研采集同时满足以下两个条件才会执行：

1. `/api/intelligence/preferences` 中的 `channels.research` 为 `true`。
2. 至少存在一个 `enabled: true` 的研究方向。

系统把所有启用方向合并为每个来源的一次有界查询，避免方向增加时线性增加外部请求。当前查询最近七天的 arXiv 与 Europe PMC 元数据，只有标题或摘要命中方向关键词的结果才进入听风证据集。

每条科研候选固定标注所属方向、核心发现、热度信号、可写切口和证据状态。arXiv 预印本会明确标注尚未同行评审；Europe PMC 的索引状态也不被当作结论已经复现。
