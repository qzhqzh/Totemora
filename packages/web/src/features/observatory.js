import { state } from "../shared/app-context.js";
import { $, escapeHtml, formatObservatoryTime } from "../shared/dom.js";
import { api, operatorApi, operatorSession } from "../shared/operator-session.js";

let loading = false;

$("refresh-observatory").addEventListener("click", () => void loadObservatory());

export const observatoryFeature = {
  load: loadObservatory,
  refreshProtected() {
    void loadObservatory();
  },
  lockProtected() {
    $("service-observatory").innerHTML = '<p class="observatory-empty">任务状态已锁定；重新登录后刷新。</p>';
    $("evidence-stream").innerHTML = '<p class="observatory-empty">受保护证据已锁定；重新登录后刷新。</p>';
  },
};

async function loadObservatory({ quiet = false } = {}) {
  if (loading) return;
  loading = true;
  const refreshButton = $("refresh-observatory");
  refreshButton.disabled = true;
  if (!quiet) $("observatory-live").textContent = "正在汇总部落现场…";
  try {
    const [latestStatus, serviceData, dossierData, assetData, candidatePool, financePool, evidenceOverview] = await Promise.all([
      api("/api/status"), api("/api/services"), api("/api/members/dossiers"),
      api("/api/assets"), api("/api/intelligence/candidates"), api("/api/finance/candidates"),
      api("/api/evidence/overview"),
    ]);
    let serviceTasks = [];
    let actions = [];
    let protectedEvidenceError;
    if (operatorSession.authenticated) {
      try {
        [{ tasks: serviceTasks }, { actions }] = await Promise.all([
          operatorApi("/api/service-tasks?limit=200"), operatorApi("/api/actions"),
        ]);
      } catch (error) {
        protectedEvidenceError = error.message;
      }
    }

    renderObservatorySummary(latestStatus, serviceData, dossierData.members, assetData.assets, serviceTasks, protectedEvidenceError);
    renderServiceObservatory(serviceData, serviceTasks, protectedEvidenceError);
    renderEvidenceStream(serviceData.services, serviceTasks, actions, dossierData.members, protectedEvidenceError);
    renderFeedbackEvidence([...candidatePool.candidates, ...financePool.candidates]);
    renderEvidenceOverview(evidenceOverview);
    $("observatory-live").classList.remove("error");
    $("observatory-live").textContent = `现场更新于 ${formatObservatoryTime(new Date().toISOString())} · 30 秒自动刷新`;
  } catch (error) {
    $("observatory-live").classList.add("error");
    $("observatory-live").textContent = `证据台读取失败：${error.message}`;
    $("observatory-summary").innerHTML = '<p class="observatory-empty">其他功能仍可使用；请检查服务后刷新现场。</p>';
  } finally {
    loading = false;
    refreshButton.disabled = false;
  }
}

function renderEvidenceOverview(overview) {
  $("evidence-funnels").innerHTML = overview.candidate_funnels.map((funnel) => {
    const label = funnel.domain === "ai" ? "听风 · AI 情报" : "观潮 · 财经情报";
    const knownSourceMetrics = funnel.sources_collected > 0;
    const feedback = funnel.valuable_candidates
      ? `${funnel.valuable_candidates} 条明确有价值`
      : "尚无明确价值反馈";
    return `<article class="funnel-line">
      <header><h4>${label}</h4><small>${funnel.scans} 次巡查 · ${feedback}</small></header>
      <ol class="funnel-stages">
        <li><span>采集</span><strong>${knownSourceMetrics ? funnel.sources_collected : "待积累"}</strong><small>${knownSourceMetrics ? `主题外 ${funnel.sources_out_of_scope}` : "新口径启用后开始统计"}</small></li>
        <li><span>主题内</span><strong>${knownSourceMetrics ? Math.max(0, funnel.sources_collected - funnel.sources_out_of_scope) : "待积累"}</strong><small>过滤 ${funnel.sources_out_of_scope} 条主题外信息</small></li>
        <li><span>新事件</span><strong>${knownSourceMetrics ? funnel.sources_sent_to_model : "待积累"}</strong><small>过滤 ${funnel.sources_history_suppressed} 条历史重复 · 避免 ${funnel.model_calls_avoided} 次模型调用</small></li>
        <li><span>候选评估</span><strong>${funnel.candidates_evaluated}</strong><small>重复率 ${formatPercent(funnel.duplicate_rate)}</small></li>
        <li><span>外发</span><strong>${funnel.candidates_pushed}</strong><small>成功率 ${formatPercent(funnel.delivery_success_rate)}</small></li>
        <li><span>价值证据</span><strong>${funnel.valuable_candidates}</strong><small>打开 ${funnel.opened_candidates} · 明确价值率 ${formatPercent(funnel.explicit_value_rate)}</small></li>
      </ol>
    </article>`;
  }).join("");
  $("evidence-notices").innerHTML = overview.notices.length
    ? overview.notices.map((notice) => `<div class="evidence-notice ${escapeHtml(notice.level)}"><strong>${escapeHtml(notice.title)}</strong><span>${escapeHtml(notice.detail)}</span></div>`).join("")
    : '<div class="evidence-notice"><strong>当前没有新增风险提示</strong><span>统计只描述已经记录的证据，不代表尚未发生的任务一定健康。</span></div>';
  $("benchmark-evidence").innerHTML = overview.recent_benchmarks.length
    ? `<div class="observatory-subhead"><h3>部落收益实验</h3><p>相同任务比较强模型、廉价模型和部落策略；结构通过率不冒充完整业务正确率。</p></div>${overview.recent_benchmarks.map((run) => `<article class="benchmark-run"><header><div><strong>${escapeHtml(run.suite_id)} v${run.suite_version}</strong><small>${run.task_count} 个任务 · ${formatObservatoryTime(run.created_at)}</small></div><span>${escapeHtml(run.pricing_status)}</span></header><div class="benchmark-strategies">${run.strategies.map((strategy) => `<div><b>${escapeHtml(strategy.id)}</b><strong>${formatPercent(strategy.structural_pass_rate)}</strong><small>${strategy.strong_model_tokens}/${strategy.total_tokens} 强模型/总 Token · 成本 ${strategy.pricing_gap_cases ? "不完整" : `$${Number(strategy.known_cost_usd).toFixed(6)}`}</small></div>`).join("")}</div></article>`).join("")}`
    : '<p class="benchmark-empty">还没有可展示的收益实验。先运行 <code>benchmarks/core-proof-v1.json</code>，结果会自动进入这里。</p>';
}

function renderObservatorySummary(latestStatus, serviceData, dossiers, assets, serviceTasks, protectedEvidenceError) {
  const activeStatuses = new Set(["queued", "routing", "running", "waiting_approval", "waiting_external"]);
  const activeTasks = serviceTasks.filter((task) => activeStatuses.has(task.status)).length;
  const provenAssets = assets.filter((asset) => asset.evidence?.length).length;
  const observedGrowth = dossiers.filter((item) => item.portrait?.evolution?.active_effect).length;
  const taskValue = !operatorSession.authenticated ? "待解锁" : protectedEvidenceError ? "读取失败" : String(activeTasks);
  $("observatory-summary").innerHTML = `<dl class="observatory-ledger">
    <div><dt>驻地</dt><dd>${latestStatus.settlement === "ready" ? "正常值守" : escapeHtml(latestStatus.settlement)}</dd></div>
    <div><dt>可用成员</dt><dd>${latestStatus.active_members} 名</dd></div>
    <div><dt>专业委任</dt><dd>${serviceData.services.length} 项</dd></div>
    <div><dt>当前任务</dt><dd>${taskValue}</dd></div>
    <div><dt>能力落地</dt><dd>${provenAssets} 项资产有实证 · ${observedGrowth} 名成员在观察成长效果</dd></div>
  </dl>`;
}

function renderServiceObservatory(serviceData, tasks, protectedEvidenceError) {
  const membersById = new Map((state.tribe?.members ?? []).map((member) => [member.id, member]));
  const activeStatuses = new Set(["queued", "routing", "running", "waiting_approval", "waiting_external"]);
  const hasTaskEvidence = operatorSession.authenticated && !protectedEvidenceError;
  $("service-observatory").innerHTML = serviceData.services.map((service) => {
    const binding = serviceData.bindings.find((item) => item.service_id === service.id);
    const specialist = membersById.get(binding?.specialist_member_id);
    const chief = membersById.get(binding?.chief_member_id);
    const serviceTasks = tasks.filter((task) => task.service_id === service.id);
    const latest = serviceTasks[0];
    const active = serviceTasks.filter((task) => activeStatuses.has(task.status)).length;
    const completed = serviceTasks.filter((task) => task.status === "completed").length;
    const failed = serviceTasks.filter((task) => task.status === "failed").length;
    const stateClass = !hasTaskEvidence ? "unknown" : active ? "working" : latest?.status === "failed" ? "attention" : "waiting";
    const stateLabel = !operatorSession.authenticated
      ? "任务状态受保护"
      : protectedEvidenceError
        ? "任务状态不可用"
        : active
          ? `${active} 项执行中`
          : latest?.status === "failed" ? "最近任务需关注" : "待命";
    const taskEvidence = !operatorSession.authenticated
      ? "输入操作员 Token 后显示任务统计"
      : protectedEvidenceError
        ? `任务证据读取失败：${escapeHtml(protectedEvidenceError)}`
        : latest
          ? `近 ${serviceTasks.length} 项：完成 ${completed} · 失败 ${failed} · 最近 ${escapeHtml(latest.current_stage)} / ${formatObservatoryTime(latest.updated_at)}`
          : "尚未留下专业任务记录";
    return `<article class="service-line">
      <div class="service-line-head">
        <div><h4>${escapeHtml(service.title)}</h4><p>${escapeHtml(service.summary)}</p></div>
        <span class="service-state ${stateClass}">${stateLabel}</span>
      </div>
      <dl class="service-binding">
        <div><dt>派工</dt><dd>${escapeHtml(chief?.name || binding?.chief_member_id || "未绑定")} → ${escapeHtml(specialist?.name || binding?.specialist_member_id || "未绑定")}</dd></div>
        <div><dt>能力</dt><dd>${(binding?.capability_evidence || service.required_capabilities).map(escapeHtml).join(" · ")}</dd></div>
        <div><dt>资产</dt><dd>${(binding?.tool_grants || service.allowed_assets).map(escapeHtml).join(" · ")}</dd></div>
      </dl>
      <p class="service-stages"><b>服务图纸</b> ${service.stages.map(escapeHtml).join(" → ")}</p>
      <small>${taskEvidence}</small>
    </article>`;
  }).join("");
}

function renderEvidenceStream(services, tasks, actions, dossiers, protectedEvidenceError) {
  const serviceTitles = new Map(services.map((service) => [service.id, service.title]));
  const items = [
    ...dossiers.flatMap((dossier) => dossier.experiences.filter((item) => item.verified).slice(0, 2).map((item) => ({
      at: item.at,
      kind: "成员经历",
      title: dossier.member.name || dossier.member.id,
      detail: `${item.kind} · ${item.summary.slice(0, 110)}`,
      tone: item.kind.includes("failure") ? "negative" : item.kind === "success" ? "positive" : "active",
    }))),
    ...tasks.slice(0, 12).map((task) => ({
      at: task.updated_at,
      kind: "专业任务",
      title: serviceTitles.get(task.service_id) || task.service_id,
      detail: `${task.member_id || task.chief_member_id || "Chief"} · ${task.status} · ${task.current_stage}`,
      tone: observatoryTone(task.status),
    })),
    ...actions.slice(0, 12).map((action) => ({
      at: action.updated_at,
      kind: "资产动作",
      title: `${action.asset_id} / ${action.action}`,
      detail: `${action.member_id} · ${action.status}${action.evidence ? ` · ${action.evidence.slice(0, 90)}` : ""}`,
      tone: observatoryTone(action.status),
    })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 8);
  const unlockNote = !operatorSession.authenticated
    ? '<p class="evidence-unlock">输入操作员 Token 后，任务阶段与资产动作也会加入这条证据流。</p>'
    : protectedEvidenceError
      ? `<p class="evidence-unlock error">受保护证据读取失败：${escapeHtml(protectedEvidenceError)}。请检查 Token 后刷新。</p>`
      : "";
  $("evidence-stream").innerHTML = items.map((item) => `<article class="evidence-item ${item.tone}">
    <div><span>${escapeHtml(item.kind)}</span><time datetime="${escapeHtml(item.at)}">${formatObservatoryTime(item.at)}</time></div>
    <h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.detail)}</p>
  </article>`).join("") + (items.length ? unlockNote : '<p class="observatory-empty">尚未留下可展示的部落证据。首次完成任务后，记录会出现在这里。</p>');
}

function renderFeedbackEvidence(candidates) {
  const feedback = candidates.map((candidate) => candidate.feedback || {});
  const positive = feedback.reduce((total, item) => total + (item.valuable || 0) + (item.opened || 0), 0);
  const corrective = feedback.reduce((total, item) => total + (item.not_valuable || 0) + (item.duplicate || 0) + (item.too_late || 0), 0);
  const unlabeled = feedback.filter((item) => !Object.values(item).some(Boolean)).length;
  $("feedback-evidence").textContent = `最近 ${candidates.length} 条候选：${positive} 次明确正向 · ${corrective} 次纠偏 · ${unlabeled} 条未标注。未标注样本不参与负向学习。`;
}

function observatoryTone(value) {
  if (["completed", "ready", "accepted"].includes(value)) return "positive";
  if (["failed", "cancelled"].includes(value)) return "negative";
  return "active";
}

function formatPercent(value) {
  return value === null || value === undefined ? "待积累" : `${Math.round(Number(value) * 100)}%`;
}
