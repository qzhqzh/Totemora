import { escapeHtml as h, time } from "./api.js";

const STATUS = { pending: "等待发送", unrouted: "未路由", coalesced: "已合并", sending: "正在发送",
  completed: "通道已接受", failed: "发送失败", uncertain: "结果不确定", executing: "发送中" };

export function renderOverview(config, status, events, deliveries) {
  const counts = Object.fromEntries((status?.events || []).map((row) => [row.status, row.count]));
  return `<section class="panel single-panel"><h2>服务运行情况</h2><p>事件先持久接收，再由独立 Notifier 路由。这里显示通道处理结果，不推断手机或收件箱已读。</p>
    <dl class="info"><dt>目标</dt><dd>${config.targets.length} 个（已启用 ${config.targets.filter((item) => item.enabled).length} 个）</dd><dt>未路由事件</dt><dd>${counts.unrouted || 0}</dd><dt>失败 / 不确定</dt><dd>${(counts.failed || 0) + (counts.uncertain || 0)}</dd><dt>SMTP</dt><dd>${config.smtp ? "已配置" : "未配置"}</dd></dl></section>
    <section class="panel single-panel"><div class="section-head"><h2>近期事件</h2><button class="secondary" type="button" data-action="go-events">查看全部</button></div>${eventRows(events.slice(0, 5))}</section>
    <section class="panel single-panel"><h2>近期通道回执</h2>${deliveryRows(deliveries.slice(0, 5))}</section>`;
}

export function renderEvents(events, deliveries) {
  return `<section class="panel single-panel"><div class="section-head"><div><h2>事件记录</h2><p>包括未路由和失败事件；无匹配规则时也不会悄悄丢弃。</p></div><button class="secondary" type="button" data-action="refresh">刷新</button></div>${eventRows(events)}</section>
    <section class="panel single-panel"><h2>逐目标投递记录</h2><p>“通道已接受”不等于终端收到；不确定状态不能自动重放。</p>${deliveryRows(deliveries)}</section>`;
}

function eventRows(events) {
  if (!events.length) return '<div class="empty">尚无事件记录。接入方上报的事件会显示在这里，包括未路由事件。</div>';
  return `<div class="rows">${events.map((item) => `<div class="row"><div class="row-main"><strong>${h(item.source)} · ${h(item.type)} <span class="status ${h(item.status)}">${STATUS[item.status] || h(item.status)}</span></strong><small>${time(item.created_at)} · ID ${h(item.id)} · 目标 ${h(item.route_targets?.join(", ") || "—")}</small>${item.last_error ? `<small>${h(item.last_error)}</small>` : ""}</div>${item.status === "failed" ? `<div class="actions"><button class="secondary" type="button" data-action="retry" data-uuid="${h(item.event_uuid)}">检查后重试</button></div>` : ""}</div>`).join("")}</div>`;
}

function deliveryRows(deliveries) {
  if (!deliveries.length) return '<div class="empty">尚无逐目标回执。发送测试后可在这里检查状态。</div>';
  return `<div class="rows">${deliveries.map((item) => `<div class="row"><div class="row-main"><strong>${h(item.channel)}:${h(item.target_id)} <span class="status ${h(item.status)}">${STATUS[item.status] || h(item.status)}</span></strong><small>${time(item.updated_at)} · 测试/事件编号 ${h(item.idempotency_key)} · 尝试 ${Number(item.attempts) || 0} 次</small>${item.error ? `<small>${h(item.error)}</small>` : ""}</div></div>`).join("")}</div>`;
}

export function renderRules(config) {
  const rules = config.rules || [];
  return `<section class="panel single-panel"><div class="section-head"><div><h2>路由规则</h2><p>按顺序匹配来源与 type 前缀，第一条命中后投递到配置目标。无匹配规则的事件留存为“未路由”。</p></div><button class="primary" type="button" data-action="create-rule">＋ 新建规则</button></div>
    ${rules.length ? `<div class="rows">${rules.map((rule, index) => `<div class="row"><div class="row-main"><strong>${index + 1}. ${h(rule.id)}</strong><small>来源 ${h(rule.source)} · type 以 ${h(rule.type_prefix)} 开头</small><small>目标 ${rule.targets.map(h).join("、")} · 合并窗口 ${Number(rule.coalesce_window_seconds) || 0} 秒</small></div><div class="actions"><button class="secondary" type="button" data-action="move-rule" data-index="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""} aria-label="上移规则 ${h(rule.id)}">↑</button><button class="secondary" type="button" data-action="move-rule" data-index="${index}" data-direction="1" ${index === rules.length - 1 ? "disabled" : ""} aria-label="下移规则 ${h(rule.id)}">↓</button><button class="secondary" type="button" data-action="edit-rule" data-index="${index}">编辑</button><button class="secondary" type="button" data-action="delete-rule" data-index="${index}">移除</button></div></div>`).join("")}</div>` : '<div class="empty">暂无规则。新事件仍会被记录，并标记为“未路由”。</div>'}</section>`;
}

export function ruleForm(config, item) {
  const sources = config.sources || [];
  const targets = config.targets || [];
  return `<h2 id="dialog-title">${item ? "修改路由规则" : "新建路由规则"}</h2><p>按列表顺序第一条匹配生效；修改规则不会改变已接收事件的历史路由。</p>
    <form class="form" id="rule-form"><label>规则 ID<input name="id" value="${h(item?.id || "")}" ${item ? "readonly" : 'pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}"'} required maxlength="64" placeholder="例如：backup-failed"></label>
    <label>来源<select name="source" required><option value="*" ${item?.source === "*" ? "selected" : ""}>所有来源 *</option>${sources.map((source) => `<option value="${h(source.id)}" ${source.id === item?.source ? "selected" : ""}>${h(source.id)}</option>`).join("")}</select></label>
    <label>type 前缀<input name="type_prefix" value="${h(item?.type_prefix || "")}" required maxlength="100" pattern="[A-Za-z][A-Za-z0-9._\\-]{0,99}" placeholder="例如：backup.failed"></label>
    <fieldset><legend>投递目标（已启用且接收 ops 事件）</legend><div class="check-row">${targets.filter((target) => target.enabled && target.domains.includes("ops") || item?.targets.includes(`${target.channel}:${target.id}`)).map((target) => `<label class="checkbox"><input type="checkbox" name="target" value="${h(target.channel)}:${h(target.id)}" ${item?.targets.includes(`${target.channel}:${target.id}`) ? "checked" : ""} ${!target.enabled || !target.domains.includes("ops") ? "disabled" : ""}>${h(target.label || target.id)} · ${h(target.channel)}${target.enabled && target.domains.includes("ops") ? "" : "（不可用；保存时移除）"}</label>`).join("") || '<span class="help">暂无可用目标。请先在目标设置中启用 ops 领域。</span>'}</div></fieldset>
    <label>重复故障合并窗口（秒）<input name="coalesce_window_seconds" type="number" value="${Number(item?.coalesce_window_seconds) || 0}" min="0" max="86400" required></label>
    <div class="form-actions"><button class="secondary" type="button" data-action="close">取消</button><button class="primary" type="submit">保存规则</button></div></form>`;
}

export function renderSettings(config) {
  return `<section class="panel single-panel"><div class="section-head"><div><h2>接入来源</h2><p>为其他业务系统创建独立凭据；凭据只在创建后显示一次，系统后续只接收事实事件。</p></div><button class="primary" type="button" data-action="create-source">＋ 新建来源</button></div>
    ${config.sources.length ? `<div class="rows">${config.sources.map((source) => `<div class="row"><div class="row-main"><strong>${h(source.id)}</strong><small>Bearer 凭据已隐藏</small></div><div class="actions"><button class="secondary" type="button" data-action="revoke-source" data-id="${h(source.id)}">撤销</button></div></div>`).join("")}</div>` : '<div class="empty">尚无外部来源。Totemora 的内部通知仍可按自身契约发送。</div>'}</section>
    <section class="panel single-panel"><div class="section-head"><div><h2>邮件设置</h2><p>${config.smtp ? `SMTP ${h(config.smtp.host)}:${Number(config.smtp.port)} · ${h(config.smtp.from)}` : "尚未配置 SMTP，不会发送邮件。"}</p></div><div class="actions"><button class="secondary" type="button" data-action="email">配置 SMTP / 收件人</button>${config.smtp ? '<button class="secondary" type="button" data-action="create-email">＋ 新收件人</button>' : ""}</div></div></section>
    <section class="panel single-panel"><h2>操作员会话</h2><p>凭据不会存入浏览器本地存储；关闭管理会话后需要重新登录。正式跨机器访问应部署 HTTPS。</p><button class="secondary" type="button" data-action="logout">退出登录</button></section>`;
}
