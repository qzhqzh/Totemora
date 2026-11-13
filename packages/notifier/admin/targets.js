import { DOMAINS, DOMAIN_LABELS, escapeHtml as h, time } from "./api.js";

const CHANNELS = { bark: "Bark", ntfy: "ntfy", telegram: "Telegram", email: "邮件" };
export const targetKey = (item) => `${item.channel}:${item.id}`;

export function renderTargets(config, selectedKey, deliveries) {
  const targets = config.targets || [];
  const selected = targets.find((item) => targetKey(item) === selectedKey)
    || targets.find((item) => item.channel === "bark") || targets[0];
  const selectedName = selected ? h(selected.label || selected.id) : "暂无目标";
  const recent = selected && deliveries.find((item) => item.channel === selected.channel && item.target_id === selected.id);
  const bark = targets.filter((item) => item.channel === "bark");
  const remaining = targets.filter((item) => item.channel !== "bark");
  return `<div class="columns">
    <section class="panel target-list" aria-label="目标清单">
      <div class="list-head"><strong>Bark 目标（${bark.length}）</strong><button class="small-button" type="button" data-action="create-bark">＋ 新建目标</button></div>
      ${bark.length ? bark.map((item) => renderRow(item, selected)).join("") : '<div class="list-note">尚未配置 Bark 手机目标。</div>'}
      ${remaining.length ? `<div class="list-note">其他通道（${remaining.length}）</div>${remaining.map((item) => renderRow(item, selected)).join("")}` : ""}
    </section>
    <section class="panel inspector" aria-label="当前通知目标详情">
      ${selected ? `<div class="detail-head"><div><h2>${selected.channel === "bark" ? "核对这部手机" : "核对通知目标"}</h2><p>只展示脱敏信息。先核对目标，再修改或测试。</p></div><span class="on ${selected.enabled ? "" : "off"}"><i class="dot" aria-hidden="true"></i> ${selected.enabled ? "已启用" : "已停用"}</span></div>
      <div class="divider"></div>
      <div class="identity">
        <div class="section-head"><h3>实际投递目标</h3><div class="actions">${selected.channel === "bark" ? '<button class="secondary" type="button" data-action="edit-bark">修改目标</button>' : selected.channel === "email" ? '<button class="secondary" type="button" data-action="email">修改邮件</button>' : ""}<button class="primary" type="button" data-action="test" ${selected.enabled ? "" : "disabled"}>发送测试</button></div></div>
        <dl class="info"><dt>目标名称</dt><dd>${selectedName}</dd><dt>目标 ID</dt><dd>${h(selected.id)}</dd><dt>通道 / 服务</dt><dd>${CHANNELS[selected.channel] || h(selected.channel)} · ${h(selected.server_host === "bark" ? "bark（容器内）" : selected.server_host || "独立 Notifier")}</dd>
          ${selected.channel === "bark" ? `<dt>设备密钥</dt><dd class="key">•••• ${h(selected.device_key_suffix || "—")} <span class="muted">（仅显示末四位）</span></dd>` : ""}
          ${selected.channel === "email" ? `<dt>收件地址</dt><dd>${h(selected.address_hint || "已脱敏")}</dd>` : ""}
          <dt>目标指纹</dt><dd>${h(selected.destination_fingerprint || "未生成")}</dd><dt>接收领域</dt><dd>${(selected.domains || []).map((domain) => h(DOMAIN_LABELS[domain] || domain)).join(" · ")}</dd></dl>
        ${selected.channel === "bark" ? `<div class="check-band"><strong>请与 Bark App 内的设备密钥末四位核对</strong><p>如果不一致，当前目标就不是你想接收通知的那台手机。还须确认 Bark App 注册到同一个 Bark 实例；容器内主机名不能直接用于手机。末位相同不保证通知已送达。</p><div class="compare"><label for="device-suffix">手机看到的末四位</label><input id="device-suffix" maxlength="4" autocomplete="off" spellcheck="false" aria-label="Bark App 中的密钥末四位"><button type="button" data-action="compare">本地核对</button><span id="match-result" role="status"></span></div></div>` : ""}
      </div>
      <div class="history"><div class="section-head"><h3>最近一次投递 · ${recent ? time(recent.updated_at) : "暂无记录"}</h3>${recent ? `<small class="muted">${h(recent.idempotency_key)}</small>` : ""}</div>
        <ol class="steps"><li><span class="step-mark" aria-hidden="true">${recent ? "✓" : "·"}</span>Notifier ${recent ? "已记录" : "尚无记录"}<span>服务内部记录</span></li>
        <li><span class="step-mark ${recent?.status !== "completed" ? "unknown" : ""}" aria-hidden="true">${recent?.status === "completed" ? "✓" : "!"}</span>${recent?.status === "completed" ? "通道已接受" : recent ? `通道状态：${h(recent.status)}` : "等待首次投递"}<span>发送通道回执</span></li>
        <li><span class="step-mark unknown" aria-hidden="true">!</span>终端是否显示：未确认<span>需在手机 / 邮箱检查</span></li></ol>
        <div class="warning">通道已接受不等于手机已显示或邮件已阅读。未知结果请先查账，不要盲目重发。</div></div>
      <div class="settings-footer"><div><strong>邮件通道</strong><small class="muted">${config.smtp ? "SMTP 已配置；收件地址单独管理" : "未配置 SMTP；不会发送邮件"}</small></div><button class="secondary" type="button" data-action="email">配置邮件</button></div>`
        : '<div class="empty">先创建一个 Bark 目标，或从独立 Notifier 的私有配置导入其他通道目标。</div><div class="settings-footer"><strong>邮件通道</strong><button class="secondary" type="button" data-action="email">配置邮件</button></div>'}
    </section>
  </div>`;
}

function renderRow(item, selected) {
  return `<button class="device" type="button" data-action="select-target" data-key="${h(targetKey(item))}" aria-current="${selected === item}"><span><strong>${h(item.label || item.id)}</strong><small>${h(item.id)} · ${CHANNELS[item.channel] || h(item.channel)}</small></span><span class="device-state ${item.enabled ? "" : "off"}"><i class="dot" aria-hidden="true"></i> ${item.enabled ? "已启用" : "已停用"}</span></button>`;
}

export function barkForm(item) {
  const isNew = !item;
  const domains = item?.domains || ["ops"];
  return `<h2 id="dialog-title">${isNew ? "新建目标" : "修改 Bark 目标"}</h2><p>密钥只写入 Notifier 的私有配置；完整值不会回显。</p>
    <form class="form" id="bark-form"><label>设备名称<input name="label" value="${h(item?.label || "")}" required maxlength="80" placeholder="例如：工作手机"></label>
    <label>目标 ID<input name="id" value="${h(item?.id || "")}" ${isNew ? 'pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}"' : "readonly"} required maxlength="64" placeholder="例如：work-phone"></label>
    <label>${isNew ? "device key" : "新的 device key"}<input name="device_key" type="password" autocomplete="new-password" ${isNew ? "required" : ""} maxlength="256" placeholder="${isNew ? "只写入，不回显" : "留空则保留现有密钥"}"></label>
    <span class="help">${item ? `当前末四位 ${h(item.device_key_suffix || "—")}。` : "请先在 Bark App 注册手机。"}完整密钥不会出现在页面或投递日志中。</span>
    <label>容器内 Bark 服务地址<input name="server_url" type="url" value="${h(item?.server_url || "http://bark:8080/")}" required maxlength="2048"></label>
    <span class="help">手机 Bark App 使用可访问的 HTTPS 地址注册；不是这里的容器域名。</span>
    <fieldset><legend>接收领域</legend><div class="check-row">${DOMAINS.map((domain) => `<label class="checkbox"><input name="domain" type="checkbox" value="${domain}" ${domains.includes(domain) ? "checked" : ""}>${h(DOMAIN_LABELS[domain])}</label>`).join("")}</div></fieldset>
    <label class="checkbox"><input name="enabled" type="checkbox" ${item?.enabled !== false ? "checked" : ""}>启用此目标</label>
    <div class="form-actions"><button class="secondary" type="button" data-action="close">取消</button><button class="primary" type="submit">保存目标</button></div></form>`;
}

export function emailForm(config, fresh = false, selectedId) {
  const email = fresh ? undefined : config.targets.find((item) => item.channel === "email" && item.id === selectedId)
    || config.targets.find((item) => item.channel === "email");
  const smtp = config.smtp;
  return `<h2 id="dialog-title">邮件通道配置</h2><p>SMTP 与收件地址只保存在独立 Notifier；其他服务只上报事件。</p><form class="form" id="email-form">
    <label>SMTP 服务器<input name="host" value="${h(smtp?.host || "")}" required maxlength="253" placeholder="smtp.example.com"></label>
    <label>端口<input name="port" type="number" min="1" max="65535" value="${h(smtp?.port || 587)}" required></label>
    <label class="checkbox"><input name="secure" type="checkbox" ${smtp?.secure ? "checked" : ""}>直接使用 TLS（通常为 465）</label>
    <label>发件账号<input name="user" value="${h(smtp?.user || "")}" required maxlength="256"></label>
    <label>应用密码<input name="password" type="password" autocomplete="new-password" ${smtp ? "" : "required"} maxlength="512" placeholder="${smtp ? "留空则保留现有密码" : "只写入，不回显"}"></label>
    <label>发件地址<input name="from" type="email" value="${h(smtp?.from || "")}" required maxlength="254"></label>
    <div class="divider"></div><label>收件目标 ID<input name="id" value="${h(email?.id || "")}" ${email ? "readonly" : 'pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}"'} required maxlength="64" placeholder="例如：owner"></label>
    <label>收件地址<input name="address" type="email" ${email ? "" : "required"} maxlength="254" placeholder="${h(email?.address_hint || "owner@example.com")}"></label>
    <span class="help">${email ? "现有地址只显示脱敏提示；留空保留原地址。" : "新目标必须填写收件地址。"}</span>
    <label class="checkbox"><input name="enabled" type="checkbox" ${email?.enabled !== false ? "checked" : ""}>启用收件目标</label>
    <div class="form-actions"><button class="secondary" type="button" data-action="close">取消</button><button class="primary" type="submit">保存邮件配置</button></div></form>`;
}
