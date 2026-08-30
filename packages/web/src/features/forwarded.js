import { $, escapeHtml, externalLink, formatObservatoryTime } from "../shared/dom.js";
import { openOperatorDialog, operatorApi, operatorSession } from "../shared/operator-session.js";

let events = [];
let health;

$("refresh-forwarded").addEventListener("click", async (event) => {
  if (!operatorSession.authenticated) return openOperatorDialog();
  const button = event.currentTarget;
  button.disabled = true;
  try { await loadForwarded(); }
  finally { button.disabled = false; }
});
$("forwarded-filter-status").addEventListener("change", () => void loadForwarded());

export const forwardedFeature = {
  loadForwarded,
  refreshProtected() { void loadForwarded(); },
  lockProtected() {
    events = [];
    health = undefined;
    renderLocked();
  },
};

async function loadForwarded() {
  if (!operatorSession.authenticated) return renderLocked();
  setSummary("正在读取上游状态与转发账本…", "loading");
  try {
    const status = $("forwarded-filter-status").value;
    const [listed, current] = await Promise.all([
      operatorApi(`/api/forwarded?status=${encodeURIComponent(status)}&limit=30`),
      operatorApi("/api/forwarded/status"),
    ]);
    events = listed.events || [];
    health = current;
    renderForwarded();
  } catch (error) {
    events = [];
    health = undefined;
    setSummary(`转发读取失败：${error.message}`, "error");
    $("forwarded-health").innerHTML = "";
    $("forwarded-list").innerHTML = empty("暂时无法读取转发案卷", "检查 Operator 登录与 forwarded.relay 状态后重试。");
  }
}

function renderLocked() {
  setSummary("输入操作员 Token 后可查看上游健康与转发内容。", "");
  $("forwarded-health").innerHTML = "";
  $("forwarded-list").innerHTML = empty("转发内容已保护", "源地址、凭据和消息内容不会出现在公开接口。");
}

function renderForwarded() {
  const counts = health?.counts || {};
  const source = health?.source;
  const attention = source?.last_error || Number(counts.failed || 0) || Number(counts.uncertain || 0);
  setSummary(
    `${events.length} 条当前案卷 · ${counts.completed || 0} 条已转发 · ${counts.deduped || 0} 条迁移重叠去重`,
    attention ? "error" : "ready",
  );
  $("forwarded-health").innerHTML = `
    <div><small>上游订阅</small><strong>${health?.configured ? "已配置" : "未配置"}</strong><span>${escapeHtml(source?.last_success_at ? formatObservatoryTime(source.last_success_at) : "尚无成功轮询")}</span></div>
    <div><small>最近轮询</small><strong>${source?.last_error ? "异常" : source ? "健康" : "等待首轮"}</strong><span>${escapeHtml(source?.last_error || (source ? `新增 ${source.last_added} 条` : "仅从受限 Secret 读取配置"))}</span></div>
    <div><small>需要处理</small><strong>${Number(counts.pending || 0) + Number(counts.failed || 0) + Number(counts.uncertain || 0)}</strong><span>未知结果保持终态，不自动重发</span></div>`;
  $("forwarded-list").innerHTML = events.map((item) => `
    <article class="forwarded-card ${escapeHtml(item.status)}">
      <header><div><small>${escapeHtml((item.tags || []).join(" · ") || "上游通知")}</small><h3>${escapeHtml(item.title || "无标题通知")}</h3></div><span>${escapeHtml(statusLabel(item.status))}</span></header>
      <p>${escapeHtml(item.body || "（上游通知无正文）")}</p>
      <footer><small>${escapeHtml(formatObservatoryTime(item.occurred_at))} · 尝试 ${Number(item.attempts || 0)} 次</small>${item.click_url ? externalLink(item.click_url, "查看来源") : ""}</footer>
    </article>`).join("") || empty("当前筛选下没有记录", "relay 只转发指定的上游 ntfy Topic，并按上游消息 ID 幂等。");
}

function statusLabel(status) {
  return ({ pending: "待转发", completed: "已接受", failed: "可重试失败", uncertain: "结果未知", deduped: "重叠去重" })[status] || status;
}
function empty(title, body) {
  return `<div class="forwarded-empty"><b>${escapeHtml(title)}</b><p>${escapeHtml(body)}</p></div>`;
}
function setSummary(text, state) {
  $("forwarded-summary").className = `notification-summary${state ? ` ${state}` : ""}`;
  $("forwarded-summary").textContent = text;
}
