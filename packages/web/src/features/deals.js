import { $, escapeHtml } from "../shared/dom.js";
import { openOperatorDialog, operatorApi, operatorSession } from "../shared/operator-session.js";

let deals = [];
let health;

$("refresh-deals").addEventListener("click", async (event) => {
  if (!operatorSession.authenticated) return openOperatorDialog();
  const button = event.currentTarget;
  button.disabled = true;
  try { await loadDeals(); }
  finally { button.disabled = false; }
});
$("deal-filter-status").addEventListener("change", () => void loadDeals());

export const dealsFeature = {
  loadDeals,
  refreshProtected() { void loadDeals(); },
  lockProtected() {
    deals = [];
    health = undefined;
    renderLocked();
  },
};

async function loadDeals() {
  if (!operatorSession.authenticated) return renderLocked();
  setSummary("正在读取优惠来源健康与去重账本…", "loading");
  try {
    const status = $("deal-filter-status").value;
    const [listed, current] = await Promise.all([
      operatorApi(`/api/deals?status=${encodeURIComponent(status)}&limit=30`),
      operatorApi("/api/deals/status"),
    ]);
    deals = listed.deals || [];
    health = current;
    renderDeals();
  } catch (error) {
    deals = [];
    health = undefined;
    setSummary(`优惠读取失败：${error.message}`, "error");
    $("deal-list").innerHTML = '<div class="deal-empty"><b>暂时无法读取优惠案卷</b><p>检查 Operator 登录与 deals.watch 状态后重试。</p></div>';
    $("deal-health").innerHTML = "";
  }
}

function renderLocked() {
  setSummary("输入操作员 Token 后可查看优惠内容与来源健康。", "");
  $("deal-health").innerHTML = "";
  $("deal-list").innerHTML = '<div class="deal-empty"><b>优惠内容已保护</b><p>商品标题、价格线索和链接只对操作员开放。</p></div>';
}

function renderDeals() {
  const counts = health?.counts || {};
  const run = health?.latest_source_run;
  const window = health?.latest_delivery_window;
  setSummary(
    `${deals.length} 条当前案卷 · ${counts.delivered || 0} 条已投递 · ${counts.skipped || 0} 条去重留档`,
    run?.status === "error" ? "error" : "ready",
  );
  $("deal-health").innerHTML = `
    <div><small>采集器</small><strong>${escapeHtml(run?.status === "error" ? "异常" : run ? "健康" : "等待首轮")}</strong><span>${escapeHtml(run?.finished_at ? localTime(run.finished_at) : "尚无运行记录")}</span></div>
    <div><small>最近时间窗</small><strong>${escapeHtml(window?.status || "尚未建立")}</strong><span>${escapeHtml(window ? `${window.local_hour.replace("T", " ")}:00 · ${window.item_count} 条` : "整点建立幂等窗口")}</span></div>
    <div><small>待处理</small><strong>${Number(counts.pending || 0)}</strong><span>失败窗口复用原选择，不改换商品</span></div>`;
  $("deal-list").innerHTML = deals.map((item) => `
    <article class="deal-card ${escapeHtml(item.status)}">
      <header><div><small>${escapeHtml(item.merchant?.split("|")[0]?.trim() || "优惠精选")}</small><h3>${escapeHtml(item.title)}</h3></div><span>${escapeHtml(statusLabel(item.status))}</span></header>
      <p class="deal-price">${escapeHtml(item.deal_text || "查看详情")}</p>
      <footer><small>${escapeHtml(localTime(item.discovered_at))}</small><a class="button secondary" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">查看来源</a></footer>
    </article>`).join("") || '<div class="deal-empty"><b>当前筛选下没有记录</b><p>deals.watch 每小时只投递最多 5 条，其余条目作为去重证据保留。</p></div>';
}

function statusLabel(status) {
  return ({ pending: "待处理", delivered: "已投递", uncertain: "结果未知", skipped: "去重留档" })[status] || status;
}

function localTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function setSummary(text, state) {
  $("deal-summary").className = `notification-summary${state ? ` ${state}` : ""}`;
  $("deal-summary").textContent = text;
}
