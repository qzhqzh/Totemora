# Zvec 采用图纸

## 当前判断

Zvec 是 Apache-2.0 的开源进程内向量数据库，官方提供 Node.js 和 Python 接入，适合 Totemora 的 local-first 方向。当前仅列为 `candidate`，尚未安装或进行部落实测。

## 可能用途

- 检索与当前工作包相关的成员经验。
- 搜索部落资产、Skill 和图纸。
- 在本地保存可检索的语义索引，不额外运行数据库服务。

## 采用前实验

1. 准备 100–1000 条带 task type、project、member、outcome 元数据的经验记录。
2. 选定独立的 embedding 模型，避免将向量库和 embedding 能力混为一谈。
3. 比较纯关键词、向量检索、混合检索的召回质量和延迟。
4. 验证更新、删除、重建、进程崩溃恢复和数据目录迁移。
5. 只有检索能稳定提高成员任务通过率，才晋升为 `adopted`。

## 官方资料

- https://zvec.org/en/docs/db/
- https://zvec.org/en/docs/db/quickstart/
- https://github.com/alibaba/zvec
