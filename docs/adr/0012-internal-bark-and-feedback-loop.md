# ADR-0012：自建 Bark 通道与用户反馈闭环

- 状态：Accepted
- 日期：2026-07-23

## 决策

使用官方 `ghcr.io/finb/bark-server:v2.3.5` 建立部落内部 Bark 通道。Totemora 使用
V2 `POST /push` JSON，服务地址与 device key 分离；默认连接
`http://127.0.0.1:18080`，不静默回退 `api.day.app`。

网络、429 和 5xx 采用 1、5、15、60 分钟退避。连续三次失败后通道熔断 30 分钟，
候选进入 `channel_blocked`，扫描继续。Bark HTTP 成功只表示通道接受请求，不表示
用户看到或打开。

Web 候选卡提供“有价值、没价值、重复、太晚”四种显式反馈。显式评价按候选和信号
幂等记录；只派生未来相似候选的有界校正，不改写模型原始评分。

Bark 没有点击 webhook。配置 `TOTEMORA_PUBLIC_BASE_URL` 后，通知点击 URL 指向
Totemora 的一次不透明 token。Gateway 记录 `opened` 后以 303 跳转原文章；token
不包含 Operator Token，不授予任何其他 API 权限。未配置手机可访问的 Gateway
地址时，通知直接打开原文。

## 安全边界

- 公网服务必须 HTTPS；明文 HTTP 只允许 localhost。
- device key 和 Basic Auth 只来自环境变量或 `.totemora/secrets`。
- Bark 数据目录包含设备映射，按秘密数据备份。
- 容器日志限制大小，不把日志上传到公共位置。
- 自建服务仍依赖 Apple APNs，不能承诺完全离线。
