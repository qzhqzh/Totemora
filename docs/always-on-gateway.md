# Gateway 常驻运行

开发时可直接执行 `bun run dev:web`。该命令使用 Bun watch mode：被运行时导入的
TypeScript/JavaScript 源码变化后自动重启 Gateway，不需要人工执行 `systemctl restart`。
`packages/web/src` 下的静态页面按请求从磁盘读取并带 `Cache-Control: no-store`，修改后
只需刷新浏览器。需要稳定、非监听式启动时使用 `bun run start:web`。

服务器长期驻扎建议交给用户级 systemd，而不是依赖终端、`nohup` 或另一个 Agent
会话。仓库提供 `ops/systemd/totemora-gateway.service` 模板；它运行非监听式的
`start:web`，默认只绑定 `127.0.0.1`，并在进程异常后 5 秒自动拉起。生产服务不使用
watch mode，部署新代码或配置后应显式重启并执行健康检查。

```bash
mkdir -p ~/.config/systemd/user ~/.config/totemora
cp ops/systemd/totemora-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now totemora-gateway
systemctl --user status totemora-gateway
```

如果仓库不在 `%h/star/app/Totemora`，先修改复制后的 `WorkingDirectory`。模板通过
`/usr/bin/env bun` 启动，并把常见的 `%h/.local/bin` 与 `%h/.bun/bin` 放入 PATH；
Bun 位于其他目录时一并调整 PATH。运行参数放在
`~/.config/totemora/gateway.env`，例如：

```dotenv
TOTEMORA_HOST=127.0.0.1
TOTEMORA_PORT=4310
TOTEMORA_CONFIG_DIR=/home/USER/star/app/Totemora/configs/example
TOTEMORA_DATA_DIR=/home/USER/star/app/Totemora/.totemora
TOTEMORA_PUBLIC_BASE_URL=https://YOUR-GATEWAY-DOMAIN
```

只有在管理员确认防火墙、TLS 反向代理和 Operator Token 边界后，才将
`TOTEMORA_HOST` 改为 `0.0.0.0`。通常保留 loopback，由同机反向代理提供受控入口。

不要把 Operator Token 或 Provider 密钥写入仓库。可在服务器管理员确认后启用用户
linger，使用户退出登录后服务仍保持：

```bash
sudo loginctl enable-linger "$USER"
```

健康检查：

```bash
curl --fail http://127.0.0.1:4310/api/status
journalctl --user -u totemora-gateway -n 100 --no-pager
```

Bark 继续由 `compose.bark.yaml` 的 `restart: unless-stopped` 管理，两者不共享进程
生命周期。Gateway 重启时，已完成外部动作依靠幂等日志避免重复执行；当前正在运行的
模型任务会转为可安全重试的失败，后续版本再引入阶段级 checkpoint 恢复。

## 开发热重载边界

- 以下规则只适用于手工运行的 `bun run dev:web`；systemd 生产模板不会 watch 源码。
- `packages/server`、被其导入的 workspace 包及依赖源码：开发模式保存后自动重载。
- `packages/web/src/index.html`、`app.js`、`styles.css`：无需重启，刷新浏览器即生效。
- `configs/`、`skills/`、`.env` 与 systemd unit：它们不是开发模式的 JavaScript import graph 的
  一部分。Skill Registry 可在页面点击“重新扫描”；配置和环境变量变化仍需执行一次
  `systemctl --user restart totemora-gateway`。
- watch mode 是自动进程重启，不是保存内存对象的 HMR。任务和治理状态继续以 SQLite
  为真源；正在执行的模型请求不会跨重载续跑。
