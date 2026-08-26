import { $, escapeHtml, externalLink } from "../shared/dom.js";
import { api, operatorApi, operatorSession } from "../shared/operator-session.js";
import { membersFeature } from "./members.js";

$("intelligence-candidates").addEventListener("click", handleCandidateFeedback);
$("finance-candidates").addEventListener("click", handleCandidateFeedback);
$("intelligence-preferences").addEventListener("submit", handleIntelligencePreferences);
$("run-intelligence").addEventListener("click", runIntelligence);
$("finance-preferences").addEventListener("submit", handleFinancePreferences);
document.querySelectorAll("[data-finance-briefing]").forEach((button) => button.addEventListener("click", () => runFinanceBriefing(button)));
$("run-finance").addEventListener("click", runFinance);

export const intelligenceFeature = {
  loadFinance,
  loadFinancePreferences,
  loadIntelligence,
  loadIntelligencePreferences,
  refreshProtected() {
    void loadIntelligence();
    void loadFinance();
  },
  lockProtected() {
    $("bark-status").textContent = "Bark 状态等待登录";
    $("finance-bark-status").textContent = "财经 Bark 路由等待登录";
    $("intelligence-preferences").reset();
    $("finance-preferences").reset();
  },
};

async function loadIntelligence() {
  const [{ briefs }, pool] = await Promise.all([api("/api/intelligence"), api("/api/intelligence/candidates")]);
  renderCandidatePool(pool, "candidate-summary", "intelligence-candidates");
  renderBriefs(briefs, "intelligence-history", "听风尚未带回情报。");
  if (operatorSession.authenticated) {
    try {
      renderBarkStatus("bark-status", await operatorApi("/api/intelligence/bark?health=1"), "AI");
    } catch (error) {
      $("bark-status").className = "channel-status error";
      $("bark-status").textContent = `Bark 状态读取失败：${error.message}`;
    }
  } else {
    $("bark-status").textContent = "输入操作员 Token 后可检查内部 Bark 健康状态";
  }
}

async function loadFinance() {
  const [{ briefs }, pool, { sources }] = await Promise.all([
    api("/api/finance"), api("/api/finance/candidates"), api("/api/finance/sources"),
  ]);
  renderCandidatePool(pool, "finance-candidate-summary", "finance-candidates");
  renderBriefs(briefs, "finance-history", "观潮尚未完成首次巡查。");
  $("finance-source-ledger").innerHTML = sources.map((source) => `<div class="source-row"><strong>${externalLink(source.url, source.name)}</strong><span class="source-state ${escapeHtml(source.status)}">${escapeHtml(source.tier)} · ${escapeHtml(source.status)}</span><p>${escapeHtml(source.summary)}</p><small>${source.last_success_at ? `上次成功 ${escapeHtml(source.last_success_at)}` : escapeHtml(source.error || "等待接入")}</small><small>${escapeHtml(source.availability)}</small></div>`).join("");
  if (operatorSession.authenticated) {
    try {
      renderBarkStatus("finance-bark-status", await operatorApi("/api/finance/bark?health=1"), "财经");
    } catch (error) {
      $("finance-bark-status").className = "channel-status error";
      $("finance-bark-status").textContent = `财经 Bark 状态读取失败：${error.message}`;
    }
  } else {
    $("finance-bark-status").textContent = "输入操作员 Token 后可检查财经 Bark 设备路由";
  }
}

function renderCandidatePool(pool, summaryId, containerId) {
  $(summaryId).textContent = `待推送 ${pool.counts.queued || 0} · 重试 ${pool.counts.retry_wait || 0} · 通道阻塞 ${pool.counts.channel_blocked || 0} · 投递未知 ${pool.counts.delivery_unknown || 0} · 抑制 ${pool.counts.held || 0} · 已推送 ${pool.counts.pushed || 0} · 失败 ${pool.counts.failed || 0}`;
  $(containerId).innerHTML = pool.candidates.slice(0, 6).map((item) => {
    const evidence = [item.evidence_tier, item.market, ...(item.symbols || []), item.event_type].filter(Boolean).map(escapeHtml).join(" · ");
    return `<article class="brief ${escapeHtml(item.status)}" data-candidate="${escapeHtml(item.id)}"><h3>${externalLink(item.url, item.headline)}</h3><p>${escapeHtml(item.brief)}</p><div class="chips">${evidence ? `${evidence} · ` : ""}${escapeHtml(item.status)} · 总分 ${Math.round(item.scores.total * 100)}（模型 ${Math.round((item.scores.base_total ?? item.scores.total) * 100)} / 反馈 ${Math.round((item.scores.feedback_adjustment || 0) * 100)}） · 可信 ${Math.round(item.scores.confidence * 100)}</div><small>${escapeHtml(item.decision)} · ${escapeHtml(item.rationale)}</small><div class="candidate-feedback" role="group" aria-label="评价这条候选消息"><button type="button" data-feedback="valuable">有价值 ${item.feedback?.valuable || ""}</button><button type="button" data-feedback="not_valuable">没价值 ${item.feedback?.not_valuable || ""}</button><button type="button" data-feedback="duplicate">重复 ${item.feedback?.duplicate || ""}</button><button type="button" data-feedback="too_late">太晚 ${item.feedback?.too_late || ""}</button></div><small class="feedback-status" aria-live="polite">${item.feedback?.opened ? `Bark 已打开 ${item.feedback.opened} 次；这是高置信正向证据` : "未反馈不会扣分；主动反馈才会校正后续相似消息"}</small></article>`;
  }).join("") || '<p class="section-note">候选池为空。可以立即扫描；失败原因会留在扫描记录中。</p>';
}

function renderBriefs(briefs, containerId, emptyText) {
  $(containerId).innerHTML = briefs.slice(0, 4).map((brief) => `<article class="brief ${escapeHtml(brief.status)}"><h3>${escapeHtml(brief.title)}</h3><p>${escapeHtml(brief.summary || brief.error || "")}</p><div class="chips">${escapeHtml(brief.created_at)} · 来源 ${brief.sources?.length || 0} · 通知 ${brief.pushed_messages || 0}</div>${(brief.items || []).map((item) => `<p><b>${externalLink(item.url, item.headline)}</b><br><small>${escapeHtml(item.brief)}</small></p>`).join("")}</article>`).join("") || `<p class="section-note">${escapeHtml(emptyText)}</p>`;
}

function renderBarkStatus(elementId, bark, domainLabel) {
  const targets = (bark.targets || []).filter((target) => target.enabled);
  const ready = targets.length > 0 && targets.every((target) => target.healthy !== false && target.channel_status === "ready");
  $(elementId).className = `channel-status ${ready ? "ready" : bark.channel_status}`;
  $(elementId).textContent = bark.configured
    ? `${domainLabel} 路由 ${targets.length} 台设备 · ${targets.map((target) => `${target.id} ${target.healthy === false ? "离线" : target.channel_status}`).join(" · ") || "无启用目标"}`
    : "Bark 尚未配置；扫描仍会继续，候选不会丢失";
}

async function handleCandidateFeedback(event) {
  const button = event.target.closest("[data-feedback]");
  if (!button) return;
  const card = button.closest("[data-candidate]");
  const statusNode = card.querySelector(".feedback-status");
  card.querySelectorAll("[data-feedback]").forEach((item) => { item.disabled = true; });
  statusNode.classList.remove("error");
  statusNode.textContent = "正在记录反馈并更新相似消息偏好…";
  try {
    const result = await operatorApi(`/api/intelligence/candidates/${encodeURIComponent(card.dataset.candidate)}/feedback`, {
      method: "POST",
      body: JSON.stringify({ signal: button.dataset.feedback }),
    });
    statusNode.textContent = result.inserted ? "反馈已记录；下一轮相似消息评估会使用这条证据" : "这条反馈已记录过，没有重复计权";
    await Promise.all([loadIntelligence(), loadFinance(), membersFeature.loadDossiers()]);
  } catch (error) {
    statusNode.classList.add("error");
    statusNode.textContent = `反馈失败：${error.message}。可再次点击重试。`;
    card.querySelectorAll("[data-feedback]").forEach((item) => { item.disabled = false; });
  }
}

async function loadIntelligencePreferences() {
  const value = await api("/api/intelligence/preferences");
  $("intelligence-interests").value = value.interests.join("\n");
  $("channel-rss").checked = value.channels.rss;
  $("channel-ai-hot").checked = value.channels.ai_hot;
  $("channel-x").checked = value.channels.x_trends;
  $("channel-weibo").checked = value.channels.weibo_hot;
  $("x-woeid").value = value.x_woeid;
  $("scan-interval").value = value.scan_interval_minutes;
  $("push-interval").value = value.push_interval_seconds;
  $("push-threshold").value = value.push_threshold;
  $("social-credential-status").textContent = `只读凭据：X ${value.credentials?.x_trends ? "已配置" : "未配置"} · 微博 ${value.credentials?.weibo_hot ? "已配置" : "未配置"}`;
}

async function handleIntelligencePreferences(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await operatorApi("/api/intelligence/preferences", {
      method: "PUT",
      body: JSON.stringify({
        interests: $("intelligence-interests").value.split("\n").map((item) => item.trim()).filter(Boolean),
        channels: {
          rss: $("channel-rss").checked,
          ai_hot: $("channel-ai-hot").checked,
          x_trends: $("channel-x").checked,
          weibo_hot: $("channel-weibo").checked,
        },
        x_woeid: Number($("x-woeid").value),
        scan_interval_minutes: Number($("scan-interval").value),
        push_interval_seconds: Number($("push-interval").value),
        push_threshold: Number($("push-threshold").value),
        novelty_history_hours: 72,
      }),
    });
    $("intelligence-preference-status").textContent = "偏好已保存；下一轮巡查生效";
  } catch (error) {
    $("intelligence-preference-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function runIntelligence() {
  const button = $("run-intelligence");
  button.disabled = true;
  $("intelligence-status").classList.remove("error");
  $("intelligence-status").textContent = "听风正在扫描、聚类并评估候选消息…";
  try {
    const task = await operatorApi("/api/intelligence/tasks", {
      method: "POST",
      body: JSON.stringify({ message_count: 3, delivery_mode: "candidate_pool", idempotency_key: `web-scan-${Date.now()}` }),
    });
    const current = await waitForTask(task, "/api/intelligence/tasks", "intelligence-status", "听风任务");
    const brief = current.result;
    const growth = current.growth_review?.status === "proposed" ? "；导师已生成成长提案" : "";
    $("intelligence-status").textContent = `扫描完成：${brief.title}，形成 ${brief.candidate_ids?.length || 0} 条候选，${brief.queued_messages || 0} 条进入推送队列${growth}`;
    await Promise.all([loadIntelligence(), membersFeature.loadDossiers(), membersFeature.loadAssets()]);
  } catch (error) {
    $("intelligence-status").textContent = error.message;
    $("intelligence-status").classList.add("error");
  } finally {
    button.disabled = false;
  }
}

async function loadFinancePreferences() {
  const value = await api("/api/finance/preferences");
  $("finance-interests").value = value.interests.join("\n");
  $("finance-watchlist").value = value.watchlist.map((item) => `${item.market}:${item.symbol}${item.name ? ` ${item.name}` : ""}`).join("\n");
  $("market-cn").checked = value.markets.includes("CN");
  $("market-hk").checked = value.markets.includes("HK");
  $("market-us").checked = value.markets.includes("US");
  $("market-jp").checked = value.markets.includes("JP");
  $("market-kr").checked = value.markets.includes("KR");
  $("finance-disclosures").checked = value.channels.disclosures;
  $("finance-regulation").checked = value.channels.regulation;
  $("finance-macro").checked = value.channels.macro;
  $("finance-global").checked = value.channels.global_official;
  $("finance-market-media").checked = value.channels.market_media;
  $("finance-asia-brief-enabled").checked = value.morning_briefings.asia_preopen.enabled;
  $("finance-asia-brief-time").value = value.morning_briefings.asia_preopen.time;
  $("finance-us-brief-enabled").checked = value.morning_briefings.us_overnight.enabled;
  $("finance-us-brief-time").value = value.morning_briefings.us_overnight.time;
  $("finance-scan-interval").value = value.scan_interval_minutes;
  $("finance-push-interval").value = value.push_interval_seconds;
  $("finance-push-threshold").value = value.push_threshold;
}

async function handleFinancePreferences(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const markets = [["CN", "market-cn"], ["HK", "market-hk"], ["US", "market-us"], ["JP", "market-jp"], ["KR", "market-kr"]]
      .filter(([, id]) => $(id).checked).map(([market]) => market);
    await operatorApi("/api/finance/preferences", {
      method: "PUT",
      body: JSON.stringify({
        interests: $("finance-interests").value.split("\n").map((item) => item.trim()).filter(Boolean),
        watchlist: readFinanceWatchlist(),
        markets,
        channels: {
          disclosures: $("finance-disclosures").checked,
          regulation: $("finance-regulation").checked,
          macro: $("finance-macro").checked,
          global_official: $("finance-global").checked,
          market_media: $("finance-market-media").checked,
        },
        scan_interval_minutes: Number($("finance-scan-interval").value),
        push_interval_seconds: Number($("finance-push-interval").value),
        push_threshold: Number($("finance-push-threshold").value),
        novelty_history_hours: 168,
        morning_briefings: {
          timezone: "Asia/Shanghai",
          asia_preopen: { enabled: $("finance-asia-brief-enabled").checked, time: $("finance-asia-brief-time").value },
          us_overnight: { enabled: $("finance-us-brief-enabled").checked, time: $("finance-us-brief-time").value },
        },
      }),
    });
    $("finance-preference-status").textContent = "范围已保存；观潮下一轮巡查生效";
    await loadFinance();
  } catch (error) {
    $("finance-preference-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function runFinanceBriefing(button) {
  const briefingType = button.dataset.financeBriefing;
  button.disabled = true;
  $("finance-status").classList.remove("error");
  $("finance-status").textContent = "观潮正在采集结构化行情、新闻证据并生成测试晨报…";
  try {
    const task = await operatorApi("/api/finance/tasks", {
      method: "POST",
      body: JSON.stringify({
        message_count: 1,
        delivery_mode: "direct_push",
        briefing_type: briefingType,
        idempotency_key: `web-finance-${briefingType}-${Date.now()}`,
      }),
    });
    const current = await waitForTask(task, "/api/finance/tasks", "finance-status", "晨报任务");
    $("finance-status").textContent = `${current.result.title} 已完成，向财经设备发送 ${current.result.pushed_messages || 0} 条`;
    await Promise.all([loadFinance(), membersFeature.loadDossiers(), membersFeature.loadAssets()]);
  } catch (error) {
    $("finance-status").textContent = error.message;
    $("finance-status").classList.add("error");
  } finally {
    button.disabled = false;
  }
}

async function runFinance() {
  const button = $("run-finance");
  button.disabled = true;
  $("finance-status").classList.remove("error");
  $("finance-status").textContent = "观潮正在读取权威来源与市场线索、核对事件并评估候选…";
  try {
    const task = await operatorApi("/api/finance/tasks", {
      method: "POST",
      body: JSON.stringify({ message_count: 5, delivery_mode: "candidate_pool", idempotency_key: `web-finance-${Date.now()}` }),
    });
    const current = await waitForTask(task, "/api/finance/tasks", "finance-status", "观潮任务");
    const brief = current.result;
    $("finance-status").textContent = `扫描完成：${brief.title}，形成 ${brief.candidate_ids?.length || 0} 条候选，${brief.queued_messages || 0} 条进入推送队列`;
    await Promise.all([loadFinance(), membersFeature.loadDossiers(), membersFeature.loadAssets()]);
  } catch (error) {
    $("finance-status").textContent = error.message;
    $("finance-status").classList.add("error");
  } finally {
    button.disabled = false;
  }
}

async function waitForTask(task, basePath, statusId, label) {
  let current = task;
  while (!["completed", "failed"].includes(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await operatorApi(`${basePath}/${encodeURIComponent(task.id)}`);
    $(statusId).textContent = `${label} ${current.status}…`;
  }
  if (current.status === "failed") throw new Error(current.error || `${label}失败`);
  return current;
}

function readFinanceWatchlist() {
  return $("finance-watchlist").value.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const match = line.match(/^(CN|HK|US|JP|KR):([^\s]+)(?:\s+(.+))?$/i);
    if (!match) throw new Error(`自选清单第 ${index + 1} 行格式不正确`);
    return { market: match[1].toUpperCase(), symbol: match[2].toUpperCase(), name: match[3]?.trim() || undefined };
  });
}
