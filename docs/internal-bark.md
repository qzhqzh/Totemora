# 内部 Bark 通知通道

Totemora 默认通过本机 `BarkNotificationService` 调用自建 Bark 的 V2 `POST /push`。
device key 与 Basic Auth 不进入仓库、成员提示词或动作证据。

## 1. 启动服务

```bash
docker compose -f compose.bark.yaml up -d
curl http://127.0.0.1:18080/ping
```

默认只绑定 `127.0.0.1`。Bark App 需要访问服务器完成设备注册，因此手机端应通过
HTTPS 反向代理或 Tailscale 访问；仅在可信局域网临时注册时，才设置
`TOTEMORA_BARK_BIND=<服务器局域网 IP>` 后重启容器。

当前服务器的正式手机入口是 `https://bark.qzhqzh.com`，由宿主机统一 Nginx
反向代理到 `127.0.0.1:18080`。站点配置源文件位于
`ops/nginx/bark.qzhqzh.com.conf`；Bark 容器本身不直接暴露公网端口。

## 2. 让 Bark App 注册设备

在 Bark App 中添加上述可从手机访问的服务地址。注册成功后，把返回的 device key
写入本机秘密文件：

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
- 连续 3 次通道失败后熔断 30 分钟；扫描继续，候选保留在 SQLite。
- 不会静默回退到 `api.day.app`。只有显式设置
  `TOTEMORA_BARK_ALLOW_LEGACY=true` 时，才读取旧的
  `.totemora/secrets/bark-url` 作为应急兼容输入。

官方依据：[Bark 部署](https://github.com/Finb/Bark/blob/master/docs/deploy.md)、
[bark-server](https://github.com/Finb/bark-server)、
[API V2](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md)。
