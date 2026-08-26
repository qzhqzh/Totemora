# JSON 到 SQLite 升级指南

Totemora `v0.9` 起使用 `.totemora/totemora.db` 作为 Gateway 可变业务状态的唯一写源。旧 JSON 会按文件 SHA-256 幂等导入；迁移不会删除或改写旧文件，也不会在切换后继续双写。

## 适用范围

- 从仍使用 JSON 状态文件的 `v0.7.x` 或 `v0.8.x` 升级；
- 更换代码版本后，希望在启动 Gateway 前确认 SQLite 完整性；
- 已存在 `totemora.db`，需要重新执行安全校验。

新安装可以直接启动 Gateway；数据库 migration 会按版本自动执行。已有 JSON 状态的实例建议使用下面的显式流程。

## 升级

1. 停止所有写入同一 `TOTEMORA_DATA_DIR` 的 Gateway、Cron 和管理命令。
2. 完整复制数据目录作为备份；备份必须包含 JSON、SQLite、WAL/SHM、Secrets 和不可变 Run 证据。
3. 使用与目标 Gateway 相同的配置和数据目录执行迁移与验证：

```bash
export TOTEMORA_CONFIG_DIR=/absolute/path/to/configs
export TOTEMORA_DATA_DIR=/absolute/path/to/.totemora
bun run storage:migrate
bun run storage:verify
```

两个命令都必须返回 `"ok": true`。`storage:verify` 同时执行 SQLite `quick_check`、外键检查，以及候选、动作、Brief 和调度租约的源数量核对。

4. 启动 Gateway，并检查：

```bash
curl --fail http://127.0.0.1:4310/api/status
bun run storage:verify
```

## 重复执行与旧数据

- 重复执行是安全的；已经导入的源文件由 `legacy_imports` 记录，不会再次追加。
- 旧 JSON 保留为只读迁移证据。切换后修改旧 JSON 会使后续导入失败，避免静默覆盖 SQLite 结论。
- 不要删除旧 JSON、`totemora.db`、`totemora.db-wal` 或 `totemora.db-shm` 来“重试”。先停止进程并使用完整备份恢复。

## 失败恢复

如果迁移或验证失败：

1. 保持 Gateway 停止，保存命令输出和失败数据目录副本；
2. 不继续写入当前目录，也不手工修改 migration 表；
3. 将整个 `TOTEMORA_DATA_DIR` 移到隔离位置；
4. 从升级前的完整备份恢复整个目录；
5. 若需要运行旧版本，确认它只访问恢复后的旧目录；新旧版本不能同时写同一数据目录。

SQLite migration 在事务中执行；失败不应留下半版本 schema。恢复后先运行原版本的只读检查，再决定修复源 JSON 或升级代码。

## 证据与边界

迁移结果会记录数据库路径、源数量、数据库数量和完整性结果。Secret、Operator Token、静态 Skill/资产和不可变 Run JSON 不迁入普通业务表，仍按原文件权限保存。

实现依据：[SQLite 持久内核 ADR](adr/0011-durable-specialist-service-kernel.md) 与 `packages/server/src/storage-cli.ts`。
