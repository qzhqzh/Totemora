# AI HOT 信息源

听风通过 AI HOT 的公开只读 REST API 获取精选动态，不安装第三方 Skill，也不抓取网页 DOM。

## 使用方式

- 每轮先请求 `/api/public/fingerprint`。
- `selected` 指纹变化后才请求 `/api/public/items?mode=selected&take=20`。
- 指纹未变化时复用 SQLite 中的上次成功批次。
- API 暂时异常时使用缓存并在扫描记录中留下 warning；从未成功过则显式失败。
- 请求使用可识别的非浏览器 User-Agent，不并发重试。

AI HOT 条目进入听风证据集时保留：

- 原始文章 URL，作为候选与推送的最终链接；
- AI HOT permalink，作为聚合与署名依据；
- 原始来源名称；
- AI HOT 分类、摘要和上游分数。

AI HOT 是二级聚合源。它适合扩大覆盖面和提供初筛信号，但摘要由 AI 生成；涉及数字、
政策、引语或安全事件时，听风必须提示回原始 URL 复核，不能把上游分数直接当作本部落
推送分数。

## 运维边界

- 匿名 GET，无 API Key。
- 当前 API 合同版本可从 `/api/public/version` 查看。
- 收到 429 后等待下一轮定时扫描，不增加并发重试。
- API 无 SLA，因此 SQLite 缓存是降级路径，不是事实永久存档。

官方合同：[Agent 与开发者接入](https://aihot.virxact.com/agent)。
