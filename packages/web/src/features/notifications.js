import { $, escapeHtml } from "../shared/dom.js";
import { operatorApi, operatorSession } from "../shared/operator-session.js";
import { intelligenceFeature } from "./intelligence.js";

let barkTargets = [];
let editingBarkTargetId;

$("refresh-bark-targets").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await loadBarkTargets();
  } finally {
    event.currentTarget.disabled = false;
  }
});
$("cancel-bark-edit").addEventListener("click", () => {
  resetBarkTargetForm();
  $("bark-target-form-status").textContent = "已取消编辑";
});
$("bark-target-form").addEventListener("submit", handleBarkTargetSubmit);
$("bark-target-list").addEventListener("click", handleBarkTargetAction);

export const notificationsFeature = {
  loadBarkTargets,
  refreshProtected() {
    void loadBarkTargets();
  },
  lockProtected() {
    barkTargets = [];
    editingBarkTargetId = undefined;
    $("bark-target-form").reset();
    $("bark-editor-title").textContent = "接入一台设备";
    $("bark-target-summary").textContent = "操作员登录已失效；重新登录后管理通知设备。";
    $("bark-target-list").innerHTML = '<p class="notification-empty">设备信息已锁定。</p>';
    $("bark-target-audit").innerHTML = '<p class="notification-empty">审计记录已锁定。</p>';
    $("bark-target-form-status").textContent = "";
  },
};

async function loadBarkTargets() {
  const summary = $("bark-target-summary");
  if (!operatorSession.authenticated) {
    barkTargets = [];
    summary.className = "notification-summary";
    summary.textContent = "输入操作员 Token 后可查看、添加和测试通知设备。";
    $("bark-target-list").innerHTML = '<div class="notification-empty"><b>设备配置已保护</b><p>Device key 和路由设置只对操作员开放。</p></div>';
    $("bark-target-audit").innerHTML = '<p class="notification-empty">输入操作员 Token 后显示最近配置与测试记录。</p>';
    setBarkEditorAvailability(false, "需要操作员 Token");
    return;
  }
  summary.className = "notification-summary loading";
  summary.textContent = "正在检查 Bark 设备与独立熔断状态…";
  try {
    const [status, audit] = await Promise.all([
      operatorApi("/api/notifications/bark/targets?health=1"),
      operatorApi("/api/notifications/bark/audit"),
    ]);
    barkTargets = status.targets || [];
    renderBarkTargets(status, audit.events || []);
  } catch (error) {
    barkTargets = [];
    summary.className = "notification-summary error";
    summary.textContent = `设备配置读取失败：${error.message}`;
    $("bark-target-list").innerHTML = '<div class="notification-empty"><b>暂时无法读取设备</b><p>检查操作员 Token 或 Gateway 状态后重试。</p></div>';
    $("bark-target-audit").innerHTML = '<p class="notification-empty">设备审计记录已锁定。</p>';
    setBarkEditorAvailability(false, "设备状态不可用");
  }
}

function renderBarkTargets(status, auditEvents) {
  const enabled = barkTargets.filter((target) => target.enabled);
  const ready = enabled.filter((target) => target.channel_status === "ready" && target.healthy !== false);
  const attention = enabled.length - ready.length;
  const summary = $("bark-target-summary");
  summary.className = `notification-summary ${attention ? "attention" : enabled.length ? "ready" : ""}`;
  summary.textContent = barkTargets.length
    ? `${barkTargets.length} 台已登记 · ${enabled.length} 台启用 · ${ready.length} 台可投递${attention ? ` · ${attention} 台需关注` : ""} · 配置保存后即时生效`
    : "尚未接入 Bark 设备；填写左侧信息即可添加第一台。";
  setBarkEditorAvailability(status.write_enabled, status.write_reason);
  $("bark-target-list").innerHTML = barkTargets.map((target) => {
    const targetState = !target.enabled
      ? { className: "disabled", label: "已停用" }
      : target.healthy === false
        ? { className: "attention", label: "健康检查失败" }
        : target.channel_status === "ready"
          ? { className: "ready", label: "可投递" }
          : { className: "attention", label: target.channel_status === "open" ? "熔断等待" : "通道降级" };
    const source = target.source === "legacy" ? "旧主设备" : target.source === "environment" ? "环境配置" : "面板管理";
    const managed = target.source === "managed" && status.write_enabled;
    return `<article class="notification-target ${targetState.className}" data-bark-target="${escapeHtml(target.id)}">
      <div class="notification-target-head"><div><h5>${escapeHtml(target.label || target.id)}</h5><small>${escapeHtml(target.id)} · ${source}</small></div><span class="notification-target-state">${targetState.label}</span></div>
      <dl><div><dt>接收</dt><dd>${target.domains.map((domain) => domain === "ai" ? "AI / 技术" : "财经 / 市场").join(" · ") || "未选择领域"}</dd></div><div><dt>密钥</dt><dd>••••${escapeHtml(target.key_suffix || "未知")}</dd></div><div><dt>服务</dt><dd>${escapeHtml(target.server_url)}</dd></div></dl>
      ${target.error ? `<p class="notification-target-error">${escapeHtml(target.error)}</p>` : ""}
      <div class="notification-target-actions"><button type="button" class="secondary" data-bark-test ${target.enabled ? "" : "disabled"}>发送测试</button>${managed ? '<button type="button" class="secondary" data-bark-edit>修改</button><button type="button" class="secondary" data-bark-toggle>' + (target.enabled ? "停用" : "启用") + "</button>" : ""}</div>
      <small class="notification-target-feedback" role="status" aria-live="polite">${target.retry_after ? `下次尝试 ${escapeHtml(new Date(target.retry_after).toLocaleString())}` : "每台设备独立记录健康与熔断状态"}</small>
    </article>`;
  }).join("") || '<div class="notification-empty"><b>还没有通知设备</b><p>先在 Bark App 中添加自建服务器，再把注册得到的 device key 填入左侧。</p></div>';
  $("bark-target-audit").innerHTML = auditEvents.slice(0, 12).map((event) => {
    const action = ({ created: "接入设备", updated: "更新路由", tested: "测试成功", test_failed: "测试失败" })[event.action] || event.action;
    return `<div class="notification-audit-row"><div><b>${escapeHtml(action)}</b><span>${escapeHtml(event.target_id)}</span></div><time datetime="${escapeHtml(event.at)}">${escapeHtml(new Date(event.at).toLocaleString())}</time>${event.detail ? `<small>${escapeHtml(event.detail)}</small>` : ""}</div>`;
  }).join("") || '<p class="notification-empty">还没有配置或测试记录。</p>';
}

function setBarkEditorAvailability(writeEnabled, reason) {
  const editor = $("bark-target-form");
  const statusNode = $("bark-target-form-status");
  editor.querySelectorAll("input, button").forEach((control) => { control.disabled = !writeEnabled; });
  if (writeEnabled) {
    $("bark-target-id").disabled = Boolean(editingBarkTargetId);
    $("bark-target-key").required = !editingBarkTargetId;
    if (["需要操作员 Token", "设备状态不可用", "当前配置只读"].includes(statusNode.textContent)) statusNode.textContent = "";
  } else {
    statusNode.textContent = reason || "当前配置只读";
  }
}

function resetBarkTargetForm() {
  editingBarkTargetId = undefined;
  $("bark-target-form").reset();
  $("bark-target-id").disabled = false;
  $("bark-target-key").required = true;
  $("bark-target-key").placeholder = "只会写入服务器，不会回显";
  $("bark-editor-title").textContent = "接入一台设备";
  $("bark-editor-note").textContent = "在 Bark App 添加自建服务器后，把注册得到的 device key 填在这里。";
  $("save-bark-target").textContent = "添加设备";
  $("cancel-bark-edit").classList.add("hidden");
}

async function handleBarkTargetSubmit(event) {
  event.preventDefault();
  const button = event.submitter;
  const statusNode = $("bark-target-form-status");
  const domains = [$("bark-domain-ai").checked && "ai", $("bark-domain-finance").checked && "finance"].filter(Boolean);
  if (!domains.length) {
    statusNode.classList.add("error");
    statusNode.textContent = "至少选择一个接收领域";
    return;
  }
  button.disabled = true;
  statusNode.classList.remove("error");
  statusNode.textContent = editingBarkTargetId ? "正在更新设备路由…" : "正在安全写入设备配置…";
  const id = editingBarkTargetId || $("bark-target-id").value.trim();
  try {
    const payload = {
      id,
      label: $("bark-target-label").value.trim(),
      device_key: $("bark-target-key").value.trim() || undefined,
      server_url: $("bark-target-server").value.trim(),
      domains,
      enabled: $("bark-target-enabled").checked,
    };
    await operatorApi(editingBarkTargetId
      ? `/api/notifications/bark/targets/${encodeURIComponent(id)}`
      : "/api/notifications/bark/targets", {
      method: editingBarkTargetId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    resetBarkTargetForm();
    statusNode.textContent = "设备配置已保存并即时生效，无需重启 Gateway";
    await refreshNotificationViews();
  } catch (error) {
    statusNode.classList.add("error");
    statusNode.textContent = `保存失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function handleBarkTargetAction(event) {
  const button = event.target.closest("[data-bark-test],[data-bark-edit],[data-bark-toggle]");
  if (!button) return;
  const card = button.closest("[data-bark-target]");
  const target = barkTargets.find((candidate) => candidate.id === card.dataset.barkTarget);
  if (!target) return;
  const feedback = card.querySelector(".notification-target-feedback");
  if (button.matches("[data-bark-edit]")) {
    editingBarkTargetId = target.id;
    $("bark-target-id").value = target.id;
    $("bark-target-id").disabled = true;
    $("bark-target-label").value = target.label || target.id;
    $("bark-target-key").value = "";
    $("bark-target-key").required = false;
    $("bark-target-key").placeholder = `留空保持当前密钥 ••••${target.key_suffix || ""}`;
    $("bark-target-server").value = target.server_url;
    $("bark-domain-ai").checked = target.domains.includes("ai");
    $("bark-domain-finance").checked = target.domains.includes("finance");
    $("bark-target-enabled").checked = target.enabled;
    $("bark-editor-title").textContent = `修改 ${target.label || target.id}`;
    $("bark-editor-note").textContent = "只修改需要变化的路由；device key 留空会安全保留原值。";
    $("save-bark-target").textContent = "保存修改";
    $("cancel-bark-edit").classList.remove("hidden");
    $("bark-target-label").focus();
    $("bark-target-form").scrollIntoView({ block: "nearest" });
    return;
  }
  button.disabled = true;
  feedback.classList.remove("error");
  try {
    if (button.matches("[data-bark-toggle]")) {
      feedback.textContent = target.enabled ? "正在停用设备…" : "正在启用设备…";
      await operatorApi(`/api/notifications/bark/targets/${encodeURIComponent(target.id)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !target.enabled }),
      });
      feedback.textContent = target.enabled ? "设备已停用；候选与其他设备不受影响" : "设备已启用并即时加入路由";
    } else {
      feedback.textContent = "正在发送测试通知…";
      await operatorApi(`/api/notifications/bark/targets/${encodeURIComponent(target.id)}/test`, {
        method: "POST",
        body: JSON.stringify({ idempotency_key: `web-bark-test:${target.id}:${Date.now()}` }),
      });
      feedback.textContent = "Bark 服务已接受测试；请检查手机通知";
    }
    await refreshNotificationViews();
  } catch (error) {
    feedback.classList.add("error");
    feedback.textContent = `${button.matches("[data-bark-toggle]") ? "更新" : "测试"}失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function refreshNotificationViews() {
  return Promise.all([
    loadBarkTargets(),
    intelligenceFeature.loadIntelligence(),
    intelligenceFeature.loadFinance(),
  ]);
}
