import { ApiError, DOMAINS, escapeHtml as h, request } from "./api.js";
import { barkForm, emailForm, renderTargets, targetKey } from "./targets.js";
import { renderEvents, renderOverview, renderRules, renderSettings, ruleForm } from "./operations.js";

const main = document.getElementById("main");
const navigation = document.getElementById("navigation");
const sidebarState = document.getElementById("sidebar-state");
const overlay = document.getElementById("overlay");
const dialog = document.getElementById("dialog");
const announcer = document.getElementById("announcer");
const sections = [
  ["overview", "总览", "服务总览", "查看事件与投递路径"],
  ["targets", "目标与通道", "通知目标", "核对设备、管理投递路径"],
  ["events", "事件与投递", "事件与投递", "追踪未路由、失败和通道回执"],
  ["rules", "路由规则", "路由规则", "按来源与 type 前缀配置接收目标"],
  ["settings", "系统设置", "系统设置", "管理接入来源与邮件通道"],
];
const state = { authenticated: false, section: "targets", config: null, events: [], deliveries: [], status: null,
  selectedKey: "", notice: "", noticeError: false, pendingDialog: null, lastFocus: null, online: false };

function notice(message, error = false) {
  state.notice = message;
  state.noticeError = error;
  announcer.textContent = message;
  render();
}

function render() {
  navigation.innerHTML = state.authenticated ? sections.map(([id, label]) => `<button type="button" data-section="${id}" class="${state.section === id ? "active" : ""}" aria-current="${state.section === id ? "page" : "false"}">${label}</button>`).join("") : "";
  sidebarState.textContent = state.authenticated ? "管理会话已连接" : "需要操作员登录";
  if (!state.authenticated) {
    main.innerHTML = `<section class="panel login"><h1>登录 Notifier</h1><p>使用本机私有 Operator Token 登录独立通知服务。凭据仅用于建立当前会话，不存储在浏览器。</p>
      ${state.notice ? `<div class="feedback ${state.noticeError ? "error" : "success"}" role="alert">${h(state.notice)}</div>` : ""}
      <form id="login-form" class="form"><label>Operator Token<input name="token" type="password" required autocomplete="off" minlength="32" maxlength="256" autofocus></label><button class="primary" type="submit">登录控制台</button></form></section>`;
    return;
  }
  const [, , title, subtitle] = sections.find(([id]) => id === state.section) || sections[1];
  let content = '<section class="panel single-panel"><div class="empty">正在载入数据…</div></section>';
  if (state.config) {
    if (state.section === "targets") content = renderTargets(state.config, state.selectedKey, state.deliveries);
    if (state.section === "overview") content = renderOverview(state.config, state.status, state.events, state.deliveries);
    if (state.section === "events") content = renderEvents(state.events, state.deliveries);
    if (state.section === "rules") content = renderRules(state.config);
    if (state.section === "settings") content = renderSettings(state.config);
  }
  main.innerHTML = `<header class="top"><div><h1>${title}</h1><p>${subtitle}</p></div><span class="state-mark ${state.online ? "" : "offline"}">独立 Notifier · ${state.online ? "在线" : "连接异常"}</span></header>
    ${state.notice ? `<div class="feedback ${state.noticeError ? "error" : "success"}" role="alert">${h(state.notice)}</div>` : ""}${content}`;
}

async function refresh() {
  try {
    const [config, events, deliveries, status] = await Promise.all([
      request("/config"), request("/events?limit=50"), request("/deliveries?limit=50"), request("/status"),
    ]);
    state.config = config;
    state.online = true;
    state.events = events.events;
    state.deliveries = deliveries.deliveries;
    state.status = status;
    if (!config.targets.some((item) => targetKey(item) === state.selectedKey)) {
      const first = config.targets.find((item) => item.channel === "bark") || config.targets[0];
      state.selectedKey = first ? targetKey(first) : "";
    }
    render();
  } catch (error) {
    state.online = false;
    if (error instanceof ApiError && error.status === 401) { state.authenticated = false; state.config = null; }
    notice(error.message, true);
  }
}

function selectedTarget() { return state.config?.targets.find((item) => targetKey(item) === state.selectedKey); }

function showDialog(content, submit) {
  state.lastFocus = document.activeElement;
  state.pendingDialog = submit || null;
  dialog.innerHTML = content;
  overlay.hidden = false;
  dialog.querySelector("input,select,button")?.focus();
}

function closeDialog() {
  overlay.hidden = true;
  dialog.innerHTML = "";
  state.pendingDialog = null;
  state.lastFocus?.focus?.();
}

function selectedDomains(form) { return [...form.querySelectorAll('input[name="domain"]:checked')].map((item) => item.value); }

const actions = {
  "select-target": (control) => { state.selectedKey = control.dataset.key; render(); },
  "compare": () => {
    const actual = main.querySelector("#device-suffix")?.value.trim();
    const result = main.querySelector("#match-result");
    const match = actual && actual === selectedTarget()?.device_key_suffix;
    result.className = match ? "match" : "mismatch";
    result.textContent = !actual ? "请输入末四位" : match ? "末四位匹配 · 仍需核对手机所用服务器" : "不匹配 · 请勿将通道受理当成手机已收到";
  },
  "create-bark": () => openBark(),
  "edit-bark": () => openBark(selectedTarget()),
  "email": () => openEmail(),
  "create-email": () => openEmail(true),
  "test": () => openTest(selectedTarget()),
  "go-events": () => { state.section = "events"; render(); },
  "refresh": () => refresh(),
  "create-rule": () => openRule(),
  "edit-rule": (control) => openRule(Number(control.dataset.index)),
  "delete-rule": (control) => changeRules("delete", Number(control.dataset.index)),
  "move-rule": (control) => changeRules("move", Number(control.dataset.index), Number(control.dataset.direction)),
  "retry": (control) => openRetry(control.dataset.uuid),
  "create-source": () => showDialog(`<h2 id="dialog-title">新建接入来源</h2><p>凭据仅显示一次，请交给接入方私下保存。不要粘贴到日志或仓库。</p><form class="form" id="source-form"><label>来源 ID<input name="id" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" maxlength="64" required placeholder="例如：backup-service"></label><div class="form-actions"><button class="secondary" type="button" data-action="close">取消</button><button class="primary" type="submit">创建凭据</button></div></form>`, async (form) => {
    const result = await request("/sources", { method: "POST", body: { revision: state.config.revision, id: form.elements.id.value.trim() } });
    await refresh();
    return () => showDialog(`<h2 id="dialog-title">来源凭据 · 仅显示一次</h2><p>请保存此凭据，关闭后页面不会再显示。来源 ID：${h(form.elements.id.value.trim())}。</p><div class="form"><label>Bearer Token<textarea readonly spellcheck="false">${h(result.source_token)}</textarea></label><div class="form-actions"><button class="primary" type="button" data-action="close">我已保存</button></div></div>`);
  }),
  "revoke-source": (control) => openRevoke(control.dataset.id),
  "logout": async () => { await request("/logout", { method: "POST" }); state.authenticated = false; state.config = null; state.notice = "已退出当前管理会话。"; render(); },
  "close": closeDialog,
};

function openBark(item) {
  showDialog(barkForm(item), async (form) => {
    const fields = form.elements;
    const payload = { revision: state.config.revision, label: fields.label.value.trim(),
      server_url: fields.server_url.value.trim(), domains: selectedDomains(form), enabled: fields.enabled.checked };
    if (fields.device_key.value) payload.device_key = fields.device_key.value;
    if (!item) payload.id = fields.id.value.trim();
    await request(item ? `/bark/${encodeURIComponent(item.id)}` : "/bark", { method: item ? "PUT" : "POST", body: payload });
    state.selectedKey = `bark:${item?.id || fields.id.value.trim()}`;
    await refresh();
    notice("目标配置已保存并在 Notifier 生效；先核对手机，再发送测试。", false);
  });
}

function openEmail(fresh = false) {
  showDialog(emailForm(state.config, fresh, selectedTarget()?.channel === "email" ? selectedTarget().id : undefined), async (form) => {
    const fields = form.elements;
    await request("/email", { method: "PUT", body: { revision: state.config.revision,
      smtp: { host: fields.host.value.trim(), port: Number(fields.port.value), secure: fields.secure.checked,
        user: fields.user.value.trim(), from: fields.from.value.trim(), ...(fields.password.value ? { password: fields.password.value } : {}) },
      target: { id: fields.id.value.trim(), address: fields.address.value.trim(), enabled: fields.enabled.checked },
    } });
    state.selectedKey = `email:${fields.id.value.trim()}`;
    await refresh();
    notice("邮件配置已保存；发送测试前请核对收件地址。", false);
  });
}

function openTest(item) {
  if (!item) return;
  const idempotencyKey = crypto.randomUUID();
  const domains = item.domains || [];
  showDialog(`<h2 id="dialog-title">发送测试前确认</h2><p>目标：${h(item.label || item.id)} · ${h(item.channel)} · ${item.device_key_suffix ? `密钥末四位 ${h(item.device_key_suffix)}` : h(item.address_hint || item.destination_fingerprint || "已脱敏")}。只发送固定测试文案，不允许自填正文。</p>
    <div class="warning">通道接收测试不等于终端收到；请到手机或邮箱确认。若请求结果未知，请先查账，不要换编号盲目重发。</div>
    <form class="form" id="test-form"><label>接收领域<select name="domain">${domains.map((domain) => `<option value="${h(domain)}">${h(domain)}</option>`).join("")}</select></label>
    <span class="help">测试编号：${h(idempotencyKey)}</span><div class="form-actions"><button class="secondary" type="button" data-action="close">取消</button><button class="primary" type="submit">确认发送测试</button></div></form>`, async (form) => {
    const result = await request("/test", { method: "POST", body: { schema_version: 1,
      channel: item.channel, target_id: item.id, domain: form.elements.domain.value, idempotency_key: idempotencyKey } });
    await refresh();
    state.section = "targets";
    notice(`测试 ${idempotencyKey}：${result.status === "completed" ? "通道已接受，终端仍未确认" : `通道状态 ${result.status}，请查看投递记录`}`, result.status !== "completed");
  });
}

function openRule(index) {
  const item = index === undefined ? null : state.config.rules[index];
  showDialog(ruleForm(state.config, item), async (form) => {
    const fields = form.elements;
    const rule = { id: fields.id.value.trim(), source: fields.source.value, type_prefix: fields.type_prefix.value.trim(),
      targets: [...form.querySelectorAll('input[name="target"]:checked')].map((input) => input.value),
      coalesce_window_seconds: Number(fields.coalesce_window_seconds.value) };
    const rules = [...state.config.rules];
    if (index === undefined) rules.push(rule); else rules[index] = rule;
    await request("/rules", { method: "PUT", body: { revision: state.config.revision, rules } });
    await refresh();
    notice("规则已保存。已接收事件的历史路由不会被改写。", false);
  });
}

async function changeRules(operation, index, direction = 0) {
  const rules = [...state.config.rules];
  if (!rules[index]) return;
  if (operation === "delete" && !confirm(`确定移除规则 ${rules[index].id}？此后不匹配的事件会保留为未路由。`)) return;
  if (operation === "delete") rules.splice(index, 1);
  else if (rules[index + direction]) [rules[index], rules[index + direction]] = [rules[index + direction], rules[index]];
  try {
    await request("/rules", { method: "PUT", body: { revision: state.config.revision, rules } });
    await refresh(); notice("规则顺序和配置已生效。", false);
  } catch (error) { notice(error.message, true); }
}

function openRetry(uuid) {
  showDialog(`<h2 id="dialog-title">确认重试失败事件</h2><p>只有明确失败的事件可以重试；未知结果不能自动重放。事件 UUID：${h(uuid)}</p><div class="form-actions"><button class="secondary" type="button" data-action="close">取消</button><button class="primary" type="button" data-action="confirm-retry" data-uuid="${h(uuid)}">确认重试</button></div>`);
}

function openRevoke(id) {
  showDialog(`<h2 id="dialog-title">撤销接入来源</h2><p>撤销 ${h(id)} 将使其现有凭据立即失效。请先移除引用该来源的路由规则。</p><div class="form-actions"><button class="secondary" type="button" data-action="close">取消</button><button class="primary" type="button" data-action="confirm-revoke" data-id="${h(id)}">确认撤销</button></div>`);
}

document.addEventListener("click", async (event) => {
  const navigationButton = event.target.closest("[data-section]");
  if (navigationButton && navigation.contains(navigationButton)) {
    state.section = navigationButton.dataset.section; state.notice = ""; render(); return;
  }
  const control = event.target.closest("[data-action]");
  if (!control || !document.querySelector(".window").contains(control)) {
    if (event.target === overlay) closeDialog(); return;
  }
  try {
    if (control.dataset.action === "confirm-retry") {
      await request(`/events/${encodeURIComponent(control.dataset.uuid)}/retry`, { method: "POST", body: {} });
      closeDialog(); await refresh(); notice("失败事件已进入待发送队列；请在事件记录中继续检查。", false);
    } else if (control.dataset.action === "confirm-revoke") {
      await request(`/sources/${encodeURIComponent(control.dataset.id)}`, { method: "DELETE", body: { revision: state.config.revision } });
      closeDialog(); await refresh(); notice("来源凭据已撤销。", false);
    } else await actions[control.dataset.action]?.(control);
  } catch (error) { notice(error.message, true); }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "login-form") {
    event.preventDefault();
    const form = event.target;
    try { await request("/login", { method: "POST", body: { token: form.elements.token.value } });
      form.elements.token.value = ""; state.authenticated = true; state.notice = ""; await refresh(); }
    catch (error) { form.elements.token.value = ""; notice(error.message, true); }
    return;
  }
  if (!overlay.hidden && state.pendingDialog && event.target.matches("form")) {
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const next = await state.pendingDialog(form);
      closeDialog();
      if (typeof next === "function") next();
    } catch (error) {
      let feedback = dialog.querySelector(".feedback");
      if (!feedback) { feedback = document.createElement("div"); dialog.insertBefore(feedback, dialog.querySelector("form")); }
      feedback.className = "feedback error";
      feedback.textContent = error.message;
      announcer.textContent = error.message;
      if (error.status === 409) {
        closeDialog();
        await refresh();
        notice("配置已经改变，请核对最新值后重新打开表单。", true);
      }
    } finally { if (submit) submit.disabled = false; }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !overlay.hidden) closeDialog();
  if (event.key === "Tab" && !overlay.hidden) {
    const controls = [...dialog.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)")];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

render();
try {
  const session = await request("/session");
  state.authenticated = session.authenticated;
  if (state.authenticated) await refresh(); else render();
} catch (error) { notice(error.message, true); }

setInterval(() => { if (state.authenticated && overlay.hidden && !document.hidden) void refresh(); }, 30_000);
