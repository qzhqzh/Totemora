# Gateway 常驻运行

开发时可直接执行 `bun run dev:web`；服务器长期驻扎建议交给用户级 systemd，而不是
依赖终端、`nohup` 或另一个 Agent 会话。仓库提供
`ops/systemd/totemora-gateway.service` 模板，失败后 5 秒自动拉起。

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
TOTEMORA_HOST=0.0.0.0
TOTEMORA_PORT=4310
TOTEMORA_CONFIG_DIR=/home/USER/star/app/Totemora/configs/example
TOTEMORA_DATA_DIR=/home/USER/star/app/Totemora/.totemora
TOTEMORA_PUBLIC_BASE_URL=https://YOUR-GATEWAY-DOMAIN
```

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
