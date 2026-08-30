# 通知传输服务：Bark 与 ntfy

Totemora 默认通过本机 `BarkNotificationService` 调用自建 Bark 的 V2 `POST /push`。
device key 与 Basic Auth 不进入仓库、成员提示词或动作证据。

同一份 `compose.bark.yaml` 也托管兼容 iOS 订阅的 ntfy 传输服务。文件名为历史兼容入口，
Compose 项目名固定为 `totemora`；它不包含旧 `notice-ntfy` 项目的 Python workers、历史
面板或第二套调度状态。

## 1. 启动服务

```bash
docker compose -f compose.bark.yaml up -d
curl http://127.0.0.1:18080/ping
curl --fail http://127.0.0.1:40011/v1/health
```

两个传输服务默认都只绑定 `127.0.0.1`。Bark App 需要访问服务器完成设备注册，因此手机端应通过
HTTPS 反向代理或 Tailscale 访问；仅在可信局域网临时注册时，才设置
`TOTEMORA_BARK_BIND=<服务器局域网 IP>` 后重启容器。

生产部署应使用管理员控制的 HTTPS 域名，由宿主机统一 Nginx 反向代理到
`127.0.0.1:18080`。仓库模板位于 `ops/nginx/bark.example.conf`；安装前必须将
`bark.example.com` 替换为实际域名。Bark 容器本身不直接暴露公网端口。

ntfy 延续 `https://ntfy.qzhqzh.com` 公网入口与 `40011` 本机端口。认证数据库和短期
cache 位于 `.totemora/ntfy-data/`，不进入 Git。旧项目退役时只迁移这两个传输层文件，
业务 worker 数据库继续作为只读恢复档案，不复制成 Totemora 的第二套运行时。

2026-08-30 已完成运行归属切换：旧 `notice-ntfy` Compose 的 workers、history、ntfy
及可选 `codex-reset` 容器均已停止并移除；没有删除旧仓库数据、Docker volume 或凭据。
后续故障只修复 Totemora 管理的服务，不恢复旧项目形成双运行时。

## 2. 让 Bark App 注册设备

在 Bark App 中添加管理员确认、可从手机访问的 HTTPS 服务地址。注册成功后，优先
通过 Web 的“双域情报台 → 通知设备”接入：

1. 打开 Totemora Web，在页头输入 `.totemora/operator-token` 的内容。
2. 在“通知设备”填写稳定的设备 ID、名称和 Bark 返回的 device key。
3. 选择该手机接收 AI、财经或两个领域，保存后点击“发送测试”。

Device key 只会通过受 Operator Token 保护的接口写入服务器，页面和 API
此后只返回末四位。配置保存后 Gateway 会在下一次投递时重新读取，无需重启
Gateway 或 Bark 容器。

如果需要脱离 Web 手工维护，现有单设备仍可写入本机秘密文件：

```bash
mkdir -p .totemora/secrets
chmod 700 .totemora/secrets
${EDITOR:-vi} .totemora/secrets/bark-device-key
chmod 600 .totemora/secrets/bark-device-key
```

宿主机端口默认使用 `18080`，避免和常见开发服务的 `8080` 冲突；容器内部仍是
`8080`。服务地址默认是 `http://127.0.0.1:18080`；需要覆盖时写入
`.totemora/secrets/bark-server-url`。公网地址必须使用 HTTPS。本机 Basic Auth
分别放在 `bark-basic-auth-user` 和 `bark-basic-auth-password`。

为避免设备密钥或 Basic Auth 被发送到未授权主机，Web 只能保存与
`TOTEMORA_BARK_SERVER_URL`（或 `bark-server-url`）同源的地址。确需管理多个 Bark
服务时，用逗号分隔的 `TOTEMORA_BARK_ALLOWED_ORIGINS` 显式加入可信 origin；不要
把普通网站或不受控服务加入该名单。

现有单 key 会自动成为只读目标 `primary`，同时接收 AI 和财经通知。Web 面板
添加的设备保存在权限为 `0600` 的 `.totemora/secrets/bark-targets.json`。手工配置格式为：

```json
[
  {
    "id": "finance-phone",
    "label": "财经手机",
    "device_key": "在服务器本地填写第二台手机的 key",
    "domains": ["finance"],
    "enabled": true,
    "server_url": "http://127.0.0.1:18080"
  }
]
```

这样 `primary` 继续接收 AI 和财经，`finance-phone` 只接收财经。若第二台也要接收两类通知，将 `domains` 改成 `["ai", "finance"]`。也可以通过 `TOTEMORA_BARK_TARGETS_JSON` 提供同一 JSON；环境变量一旦设置即成为权威只读来源，Web 只能查看和测试，不能覆盖它。生产环境优先使用权限为 `600` 的 Secret 文件，避免环境诊断输出密钥。

目标 ID 必须唯一；相同 Bark 服务和 device key 的重复目标会被去重。Web 会展示
目标 ID、名称、领域、服务器、健康/熔断状态和密钥末四位，永不返回完整 device key。
每次新增、更新和测试都会留下不含密钥的审计记录。

## 3. 点击反馈

如果手机能够访问 Totemora Gateway，设置：

```bash
TOTEMORA_PUBLIC_BASE_URL=https://totemora.example
```

通知的 `url` 会变成一次不透明回执链接。点击时 Totemora 幂等记录 `opened`
弱正向反馈（0.2 份经验信用），再以 303 跳转到原文章。Bark 本身没有点击 webhook；
未设置可访问的公开地址时，通知直接打开原文章，不做点击追踪。

## 4. 可靠性语义

- Bark 接受请求只记为“通道已接受”，不声称用户已看到。
- 网络、429 和 5xx 按 1、5、15、60 分钟退避。
- 每个目标连续 3 次通道失败后独立熔断 30 分钟；其他手机继续接收，候选保留在 SQLite 并按目标幂等重试。
- 不会静默回退到 `api.day.app`。只有显式设置
  `TOTEMORA_BARK_ALLOW_LEGACY=true` 时，才读取旧的
  `.totemora/secrets/bark-url` 作为应急兼容输入。

官方依据：[Bark 部署](https://github.com/Finb/Bark/blob/master/docs/deploy.md)、
[bark-server](https://github.com/Finb/bark-server)、
[API V2](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md)。
