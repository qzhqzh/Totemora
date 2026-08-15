const $ = (id) => document.getElementById(id);
const skillsRoute = location.pathname === "/skills" || location.pathname === "/skills/";
document.body.classList.toggle("route-skills", skillsRoute);
document.title = skillsRoute ? "技能 · 铁锅部落" : "铁锅部落";
document.querySelectorAll("[data-primary-route]").forEach((link) => {
  const active = link.dataset.primaryRoute === (skillsRoute ? "skills" : "home");
  if (active) link.setAttribute("aria-current", "page");
  else link.removeAttribute("aria-current");
});
const phases = { queued: 8, planning: 25, executing: 55, reviewing: 78, repairing: 68, cancelling: 85, cancelled: 100, completed: 100, failed: 100 };
let tribe;
let status;
let settlement;
let activeJobId;
let activeDevelopmentProposal;
let activeDevelopmentTaskId;
let memberDossiers = [];
let activeMemberId;
let contentWorks = [];
const contentIllustrationUrls = new Map();
let observatoryLoading = false;
let barkTargets = [];
let editingBarkTargetId;
let registrySkills = [];
let activeRegistrySkillId;
let activeRegistryFilePath;
let skillTrialRuns = [];
let skillCommissions = [];

let operatorAuthenticated = false;
let operatorSessionRevision = 0;
$("operator-token").value = sessionStorage.getItem("totemora_operator_token") || "";

function setOperatorAuthState(state, message) {
  operatorAuthenticated = state === "authenticated";
  $("operator-login-open").classList.toggle("authenticated", operatorAuthenticated);
  $("operator-auth-state").textContent = operatorAuthenticated ? "已认证" : state === "invalid" ? "认证失败" : "未登录";
  $("operator-login-label").textContent = operatorAuthenticated ? "操作员账户" : "操作员登录";
  $("operator-logout").classList.toggle("hidden", !operatorAuthenticated);
  $("operator-login-status").className = `operator-login-status${state === "authenticated" ? " success" : state === "invalid" ? " error" : ""}`;
  $("operator-login-status").textContent = message ?? (operatorAuthenticated ? "Token 已通过服务器验证，仅保存在当前标签页。" : "Token 仅保存在当前浏览器标签页。");
}

function openOperatorDialog() {
  setOperatorAuthState(operatorAuthenticated ? "authenticated" : "anonymous");
  $("operator-dialog").showModal();
  window.setTimeout(() => $("operator-token").focus(), 0);
}

async function refreshProtectedViews() {
  for (const url of contentIllustrationUrls.values()) URL.revokeObjectURL(url);
  contentIllustrationUrls.clear();
  if (!operatorAuthenticated) clearProtectedDevelopmentUi();
  if (skillsRoute) {
    void loadSkillCommissions();
    if (activeRegistrySkillId) renderSkillRegistryDetail(registrySkills.find((skill) => skill.id === activeRegistrySkillId));
    return;
  }
  void loadDevelopmentHistory();
  void loadObservatory();
  void loadContentStudio();
  void loadIntelligence();
  void loadFinance();
  void loadBarkTargets();
  void loadSkillCommissions();
  if (activeRegistrySkillId) renderSkillRegistryDetail(registrySkills.find((skill) => skill.id === activeRegistrySkillId));
}

function invalidateOperatorSession(message, { clearInput = true } = {}) {
  operatorSessionRevision += 1;
  sessionStorage.removeItem("totemora_operator_token");
  operatorAuthenticated = false;
  if (clearInput) $("operator-token").value = "";
  for (const url of contentIllustrationUrls.values()) URL.revokeObjectURL(url);
  contentIllustrationUrls.clear();
  contentWorks = [];
  barkTargets = [];
  skillCommissions = [];
  skillTrialRuns = [];
  editingBarkTargetId = undefined;
  clearProtectedDevelopmentUi();
  setOperatorAuthState("invalid", message);
  $("skill-commissions").innerHTML = '<p class="skill-empty">操作员登录已失效；重新登录后显示能力委任。</p>';
  $("service-observatory").innerHTML = '<p class="observatory-empty">任务状态已锁定；重新登录后刷新。</p>';
  $("evidence-stream").innerHTML = '<p class="observatory-empty">受保护证据已锁定；重新登录后刷新。</p>';
  $("bark-target-form").reset();
  $("bark-editor-title").textContent = "接入一台设备";
  $("bark-target-summary").textContent = "操作员登录已失效；重新登录后管理通知设备。";
  $("bark-target-list").innerHTML = '<p class="notification-empty">设备信息已锁定。</p>';
  $("bark-target-audit").innerHTML = '<p class="notification-empty">审计记录已锁定。</p>';
  $("bark-target-form-status").textContent = "";
  $("bark-status").textContent = "Bark 状态等待登录";
  $("finance-bark-status").textContent = "财经 Bark 路由等待登录";
  $("intelligence-preferences").reset();
  $("finance-preferences").reset();
  $("content-create-form").reset();
  $("content-schedule-form").reset();
  $("content-summary").textContent = "操作员登录已失效";
  $("content-works").innerHTML = '<div class="content-empty"><b>作品案卷已锁定</b><p>重新登录后读取部落作品。</p></div>';
  $("content-create-status").textContent = "";
  $("content-schedule-status").textContent = "";
  if (activeRegistrySkillId) renderSkillRegistryDetail(registrySkills.find((skill) => skill.id === activeRegistrySkillId));
}

async function validateOperatorSession({ closeOnSuccess = false } = {}) {
  const submit = $("operator-login-submit");
  const candidateToken = $("operator-token").value.trim();
  submit.disabled = true;
  $("operator-login-status").className = "operator-login-status";
  $("operator-login-status").textContent = "正在向服务器验证…";
  try {
    if (!candidateToken) throw new Error("请输入操作员 Token");
    await api("/api/operator/session", { headers: { authorization: `Bearer ${candidateToken}` } });
    if ($("operator-token").value.trim() !== candidateToken) throw new Error("Token 已更改，请重新验证");
    sessionStorage.setItem("totemora_operator_token", candidateToken);
    operatorSessionRevision += 1;
    setOperatorAuthState("authenticated");
    await refreshProtectedViews();
    if (closeOnSuccess) $("operator-dialog").close();
    return true;
  } catch (error) {
    invalidateOperatorSession(error.status === 401 ? "Token 不正确，请从服务器的 .totemora/operator-token 重新复制。" : error.message);
    return false;
  } finally {
    submit.disabled = false;
  }
}

$("operator-login-open").addEventListener("click", openOperatorDialog);
$("operator-dialog-close").addEventListener("click", () => $("operator-dialog").close());
$("operator-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void validateOperatorSession({ closeOnSuccess: true });
});
$("operator-logout").addEventListener("click", () => {
  invalidateOperatorSession("已退出登录；受保护操作已锁定。");
  setOperatorAuthState("anonymous", "已退出登录；受保护操作已锁定。");
  void refreshProtectedViews();
});
$("operator-token").addEventListener("input", () => {
  sessionStorage.removeItem("totemora_operator_token");
  if (operatorAuthenticated) invalidateOperatorSession("Token 已更改，验证后才会重新解锁。", { clearInput: false });
  else setOperatorAuthState("anonymous", "验证新 Token 后才会保存。");
});
if ($("operator-token").value.trim()) void validateOperatorSession();

$("refresh-observatory").addEventListener("click", () => void loadObservatory());

async function loadTribe() {
  [tribe, status] = await Promise.all([api("/api/tribe"), api("/api/status")]);
  $("tribe-status").textContent = `${status.version} · ${tribe.tribe.name} · ${status.active_members} 名可用成员`;
  $("roster").innerHTML = tribe.members.map((member) => `
    <article class="member ${member.id === tribe.tribe.chief ? "chief" : ""}">
      <strong>${escapeHtml(member.name)} <small>v${member.version} · ${escapeHtml(member.status)}</small></strong>
      <p>${escapeHtml(member.model)} / ${escapeHtml(member.provider)}</p>
      <small>${member.skills.map(escapeHtml).join(" · ") || "暂无 Skill"}</small>
    </article>`).join("");
  renderCodex();
  await Promise.all([
    loadEmbers(), loadAssets(), loadMemberDossiers(), loadIntelligence(), loadIntelligencePreferences(),
    loadFinance(), loadFinancePreferences(), loadContentStudio(), loadBarkTargets(), loadSkillCommissions(), loadSkillRegistry(),
  ]);
  await loadObservatory();
  $("chief").innerHTML = tribe.members.filter((m) => m.roles.includes("chief") && !["inactive", "retired"].includes(m.status))
    .map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === tribe.tribe.chief ? "selected" : ""}>${escapeHtml(m.name)} · ${escapeHtml(m.model)}</option>`).join("");
  await loadHistory();
  await loadSettlement();
  await loadDevelopmentHistory();
}

async function loadObservatory({ quiet = false } = {}) {
  if (observatoryLoading) return;
  observatoryLoading = true;
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
    if (operatorAuthenticated) {
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
    observatoryLoading = false;
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

function formatPercent(value) {
  return value === null || value === undefined ? "待积累" : `${Math.round(Number(value) * 100)}%`;
}

function renderObservatorySummary(latestStatus, serviceData, dossiers, assets, serviceTasks, protectedEvidenceError) {
  const activeStatuses = new Set(["queued", "routing", "running", "waiting_approval", "waiting_external"]);
  const activeTasks = serviceTasks.filter((task) => activeStatuses.has(task.status)).length;
  const provenAssets = assets.filter((asset) => asset.evidence?.length).length;
  const observedGrowth = dossiers.filter((item) => item.portrait?.evolution?.active_effect).length;
  const taskValue = !operatorAuthenticated ? "待解锁" : protectedEvidenceError ? "读取失败" : String(activeTasks);
  $("observatory-summary").innerHTML = `<dl class="observatory-ledger">
    <div><dt>驻地</dt><dd>${latestStatus.settlement === "ready" ? "正常值守" : escapeHtml(latestStatus.settlement)}</dd></div>
    <div><dt>可用成员</dt><dd>${latestStatus.active_members} 名</dd></div>
    <div><dt>专业委任</dt><dd>${serviceData.services.length} 项</dd></div>
    <div><dt>当前任务</dt><dd>${taskValue}</dd></div>
    <div><dt>能力落地</dt><dd>${provenAssets} 项资产有实证 · ${observedGrowth} 名成员在观察成长效果</dd></div>
  </dl>`;
}

function renderServiceObservatory(serviceData, tasks, protectedEvidenceError) {
  const membersById = new Map(tribe.members.map((member) => [member.id, member]));
  const activeStatuses = new Set(["queued", "routing", "running", "waiting_approval", "waiting_external"]);
  const hasTaskEvidence = operatorAuthenticated && !protectedEvidenceError;
  $("service-observatory").innerHTML = serviceData.services.map((service) => {
    const binding = serviceData.bindings.find((item) => item.service_id === service.id);
    const specialist = membersById.get(binding?.specialist_member_id);
    const chief = membersById.get(binding?.chief_member_id);
    const serviceTasks = tasks.filter((task) => task.service_id === service.id);
    const latest = serviceTasks[0];
    const active = serviceTasks.filter((task) => activeStatuses.has(task.status)).length;
    const completed = serviceTasks.filter((task) => task.status === "completed").length;
    const failed = serviceTasks.filter((task) => task.status === "failed").length;
    const state = !hasTaskEvidence ? "unknown" : active ? "working" : latest?.status === "failed" ? "attention" : "waiting";
    const stateLabel = !operatorAuthenticated
      ? "任务状态受保护"
      : protectedEvidenceError
        ? "任务状态不可用"
        : active
          ? `${active} 项执行中`
          : latest?.status === "failed" ? "最近任务需关注" : "待命";
    const taskEvidence = !operatorAuthenticated
      ? "输入操作员 Token 后显示任务统计"
      : protectedEvidenceError
        ? `任务证据读取失败：${escapeHtml(protectedEvidenceError)}`
        : latest
          ? `近 ${serviceTasks.length} 项：完成 ${completed} · 失败 ${failed} · 最近 ${escapeHtml(latest.current_stage)} / ${formatObservatoryTime(latest.updated_at)}`
          : "尚未留下专业任务记录";
    return `<article class="service-line">
      <div class="service-line-head">
        <div><h4>${escapeHtml(service.title)}</h4><p>${escapeHtml(service.summary)}</p></div>
        <span class="service-state ${state}">${stateLabel}</span>
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
      at: item.at, kind: "成员经历", title: dossier.member.name || dossier.member.id,
      detail: `${item.kind} · ${item.summary.slice(0, 110)}`,
      tone: item.kind.includes("failure") ? "negative" : item.kind === "success" ? "positive" : "active",
    }))),
    ...tasks.slice(0, 12).map((task) => ({
      at: task.updated_at, kind: "专业任务", title: serviceTitles.get(task.service_id) || task.service_id,
      detail: `${task.member_id || task.chief_member_id || "Chief"} · ${task.status} · ${task.current_stage}`,
      tone: observatoryTone(task.status),
    })),
    ...actions.slice(0, 12).map((action) => ({
      at: action.updated_at, kind: "资产动作", title: `${action.asset_id} / ${action.action}`,
      detail: `${action.member_id} · ${action.status}${action.evidence ? ` · ${action.evidence.slice(0, 90)}` : ""}`,
      tone: observatoryTone(action.status),
    })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 8);
  const unlockNote = !operatorAuthenticated
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

function formatObservatoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

async function loadSkillCommissions() {
  const container = $("skill-commissions");
  if (!operatorAuthenticated) {
    container.innerHTML = '<p class="skill-empty">输入操作员 Token 后显示能力委任。对话、试用和激活记录默认不公开。</p>';
    return;
  }
  container.innerHTML = '<p class="skill-empty">正在读取能力委任…</p>';
  try {
    const [{ commissions }, { runs }] = await Promise.all([
      operatorApi("/api/skills/commissions"), operatorApi("/api/skills/trial-runs"),
    ]);
    skillTrialRuns = runs;
    skillCommissions = commissions;
    renderSkillCommissions(skillCommissions);
  } catch (error) {
    container.innerHTML = `<p class="skill-empty error">能力委任读取失败：${escapeHtml(error.message)}</p>`;
  }
}

async function loadSkillRegistry({ keepSelection = true, refresh = false } = {}) {
  const list = $("skill-registry-list");
  const detail = $("skill-registry-detail");
  const live = $("skill-registry-live");
  const button = $("refresh-skill-registry");
  button.disabled = true;
  live.classList.remove("error");
  live.textContent = "正在扫描允许目录…";
  list.innerHTML = '<p class="skill-empty">正在读取仓库 Skill…</p>';
  if (!keepSelection) detail.innerHTML = '<div class="skill-registry-placeholder"><h3>正在重新扫描</h3><p>文件内容不会写入数据库，页面将显示扫描后的真实状态。</p></div>';
  try {
    const result = await api(`/api/skills/registry${refresh ? "?refresh=1" : ""}`);
    registrySkills = result.skills;
    $("skill-registry-root").textContent = `${result.root}/`;
    renderSkillRegistrySummary(registrySkills);
    if (!registrySkills.length) {
      activeRegistrySkillId = undefined;
      list.innerHTML = '<div class="skill-registry-placeholder"><h3>还没有 Skill</h3><p>在仓库 skills/&lt;skill-id&gt;/SKILL.md 中加入第一个开放格式 Skill 后重新扫描。</p></div>';
      detail.innerHTML = '<div class="skill-registry-placeholder"><h3>等待文件来源</h3><p>Totemora 不会在页面中伪造或用数据库正文替代 Skill 文件。</p></div>';
    } else {
      const requested = new URLSearchParams(location.search).get("skill");
      const selected = keepSelection
        ? registrySkills.find((skill) => skill.id === activeRegistrySkillId)
          || registrySkills.find((skill) => skill.id === requested)
          || registrySkills[0]
        : registrySkills.find((skill) => skill.id === requested) || registrySkills[0];
      activeRegistrySkillId = selected.id;
      renderSkillRegistryList();
      renderSkillRegistryDetail(selected);
    }
    live.textContent = `${registrySkills.length} 个 Skill · 扫描于 ${formatObservatoryTime(result.scanned_at)}`;
  } catch (error) {
    registrySkills = [];
    activeRegistrySkillId = undefined;
    $("skill-registry-summary").innerHTML = "";
    list.innerHTML = `<div class="skill-registry-placeholder"><h3>技能库读取失败</h3><p>${escapeHtml(error.message)}</p></div>`;
    detail.innerHTML = '<div class="skill-registry-placeholder"><h3>无法显示详情</h3><p>请检查 Gateway 和仓库 skills/ 目录后重新扫描。</p></div>';
    live.classList.add("error");
    live.textContent = `扫描失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function renderSkillRegistrySummary(skills) {
  const counts = { active: 0, candidate: 0, warning: 0, invalid: 0 };
  for (const skill of skills) counts[skill.status] = (counts[skill.status] || 0) + 1;
  $("skill-registry-summary").innerHTML = [
    ["已装备", counts.active, "活动版本或仓库声明"],
    ["候选", counts.candidate, "结构校验通过"],
    ["需关注", counts.warning, "存在非阻断警告"],
    ["不可用", counts.invalid, "Doctor 阻断"],
  ].map(([label, value, note]) => `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
}

function renderSkillRegistryList() {
  $("skill-registry-list").innerHTML = registrySkills.map((skill) => `<button type="button" class="skill-registry-item" data-registry-skill="${escapeHtml(skill.id)}" aria-pressed="${skill.id === activeRegistrySkillId}">
    <span><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(skill.id)} · ${escapeHtml(skill.version ? `v${skill.version}` : skill.hash_short)}</small><em>查看详情</em></span>
    <span class="skill-registry-state ${escapeHtml(skill.status)}">${escapeHtml(registryStatusLabel(skill.status))}</span>
  </button>`).join("");
}

function renderSkillRegistryDetail(skill) {
  const detail = $("skill-registry-detail");
  if (!skill) {
    detail.innerHTML = '<div class="skill-registry-placeholder"><h3>选择一个 Skill</h3><p>查看文件组成、content hash、Doctor 结果和现有治理证据。</p></div>';
    return;
  }
  const defaultFile = skill.files.find((file) => file.path === "SKILL.md") || skill.files[0];
  if (!activeRegistryFilePath || !skill.files.some((file) => file.path === activeRegistryFilePath)) {
    activeRegistryFilePath = defaultFile?.path;
  }
  const validation = skill.validation;
  const binding = skill.binding.member_ids.length
    ? skill.binding.member_ids.map(memberLabel).join(" · ")
    : skill.binding.tribe_ids.length ? skill.binding.tribe_ids.join(" · ") : "未绑定";
  const issues = validation.issues.length
    ? `<ul class="skill-validation-issues">${validation.issues.map((issue) => `<li><b class="${escapeHtml(issue.severity)}">${issue.severity === "error" ? "阻断" : "提醒"}</b><span>${escapeHtml(issue.message)}</span><small>${escapeHtml(issue.file || issue.code)}</small></li>`).join("")}</ul>`
    : '<p class="skill-empty">Doctor 没有发现结构、引用、路径或 Secret 风险。</p>';
  const files = renderSkillFileBrowser(skill);
  const commission = skill.governance.latest_commission;
  const activation = skill.governance.activation;
  const trials = skill.governance.trials;
  const activationDetail = activation
    ? `${escapeHtml(activation.status)} · v${activation.version}<br><code>${escapeHtml(activation.digest.slice(0, 12))}</code>`
    : skill.status === "active" ? `仓库声明 · ${skill.version ? `v${skill.version}` : skill.hash_short}` : "尚未激活";
  detail.innerHTML = `<div class="skill-detail-head">
    <div><h3>${escapeHtml(skill.name)}</h3><p>${escapeHtml(skill.description)}</p><small><code>${escapeHtml(skill.id)}</code> · ${skill.version ? `v${skill.version}` : escapeHtml(skill.hash_short)}</small></div>
    <span class="skill-registry-state ${escapeHtml(skill.status)}">${escapeHtml(registryStatusLabel(skill.status))}</span>
  </div>
  <div class="skill-detail-section skill-package-primary"><h4>Skill 包</h4><p class="skill-section-note">浏览仓库中的完整目录；文本内容需要操作员 Token，只读且不会执行脚本。</p>${files}</div>
  <dl class="skill-detail-meta">
    <div><dt>Skill ID</dt><dd><code>${escapeHtml(skill.id)}</code></dd></div>
    <div><dt>来源</dt><dd>本地仓库 · <code>${escapeHtml(skill.path)}</code>${skill.source.reference ? `<br><small>${escapeHtml(skill.source.provenance_kind || "provenance")} · ${escapeHtml(skill.source.reference)}</small>` : ""}</dd></div>
    <div><dt>版本 / Content hash</dt><dd>${skill.version ? `v${skill.version} · ` : ""}<code title="${escapeHtml(skill.content_hash)}">${escapeHtml(skill.hash_short)}</code></dd></div>
    <div><dt>绑定</dt><dd>${escapeHtml(binding)}</dd></div>
  </dl>
  <div class="skill-detail-section"><h4>Doctor 验证</h4>
    <div class="skill-validation-summary ${escapeHtml(validation.status)}"><strong>${escapeHtml(validationStatusLabel(validation.status))}</strong><small>${validation.checks} 类检查 · ${escapeHtml(formatObservatoryTime(validation.checked_at))}</small></div>${issues}
  </div>
  <div class="skill-detail-section"><h4>治理与试炼</h4><div class="skill-governance-evidence">
    <div><span>活动版本</span><strong>${activation ? `v${activation.version}` : skill.status === "active" ? skill.version ? `v${skill.version}` : "仓库活动态" : "未装备"}</strong><small>${activationDetail}</small></div>
    <div><span>最近委任</span><strong>${commission ? escapeHtml(skillStatusLabel(commission.status)) : "无案卷"}</strong><small>${commission ? `<code>${escapeHtml(commission.id)}</code><br>${escapeHtml(formatObservatoryTime(commission.updated_at))}` : "还没有 Commission 证据"}</small></div>
    <div><span>最近试炼</span><strong>${trials.accepted}/${trials.total} 通过</strong><small>${trials.total ? `${trials.rejected} 次未通过${trials.last_at ? ` · ${escapeHtml(formatObservatoryTime(trials.last_at))}` : ""}` : "尚无试炼证据"}</small></div>
  </div>${commission ? `<div class="skill-detail-actions"><a href="#skill-council" data-open-skill-commission="${escapeHtml(commission.id)}">查看委任 / 试炼</a></div>` : ""}</div>`;

  if (activeRegistryFilePath) {
    void loadSkillFilePreview(skill.id, activeRegistryFilePath, { interactive: false });
  }
}

function renderSkillFileBrowser(skill) {
  if (!skill.files.length) return '<p class="skill-empty">没有可展示的包文件。</p>';
  const tree = { directories: new Map(), files: [] };
  for (const file of skill.files) {
    const parts = file.path.split("/");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      if (!node.directories.has(part)) node.directories.set(part, { directories: new Map(), files: [] });
      node = node.directories.get(part);
    }
    node.files.push(file);
  }
  return `<div class="skill-package-browser">
    <nav class="skill-file-tree" aria-label="${escapeHtml(skill.name)} 文件目录">${renderSkillTreeNode(tree)}</nav>
    <section id="skill-file-preview" class="skill-file-preview" aria-live="polite">
      <div class="skill-file-preview-empty"><strong>选择文件查看内容</strong><p>${operatorAuthenticated ? "可预览 SKILL.md、配置、脚本和参考文本；资产与敏感文件只显示目录信息。" : "先从页面右上角完成操作员登录，再选择文本文件。"}</p></div>
    </section>
  </div>`;
}

function renderSkillTreeNode(node) {
  const directories = [...node.directories.entries()].sort(([left], [right]) => left.localeCompare(right));
  const files = [...node.files].sort((left, right) => left.path.localeCompare(right.path));
  return `<ul>${directories.map(([name, child]) => `<li class="skill-directory"><span><b>目录</b>${escapeHtml(name)}</span>${renderSkillTreeNode(child)}</li>`).join("")}${files.map((file) => `<li><button type="button" data-skill-file="${escapeHtml(file.path)}" aria-pressed="${file.path === activeRegistryFilePath}"><b>${escapeHtml(fileKindLabel(file.kind))}</b><span>${escapeHtml(file.path.split("/").at(-1))}</span><small>${formatFileSize(file.size)}</small></button></li>`).join("")}</ul>`;
}

async function loadSkillFilePreview(skillId, filePath, { interactive = false } = {}) {
  const preview = $("skill-file-preview");
  if (!preview) return;
  activeRegistryFilePath = filePath;
  document.querySelectorAll("[data-skill-file]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.skillFile === filePath)));
  if (!operatorAuthenticated) {
    preview.innerHTML = `<div class="skill-file-preview-empty"><strong>${escapeHtml(filePath)}</strong><p>完成右上角操作员登录后，可直接预览文件正文与脚本内容。</p></div>`;
    if (interactive) openOperatorDialog();
    return;
  }
  preview.innerHTML = `<div class="skill-file-preview-empty"><strong>正在读取 ${escapeHtml(filePath)}</strong><p>内容来自当前仓库快照。</p></div>`;
  try {
    const file = await operatorApi(`/api/skills/registry/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(filePath)}`);
    if (activeRegistrySkillId !== skillId || activeRegistryFilePath !== filePath) return;
    preview.innerHTML = `<header><div><strong>${escapeHtml(file.path)}</strong><small>${escapeHtml(fileKindLabel(file.kind))} · ${formatFileSize(file.size)}</small></div><span>只读</span></header><pre><code>${escapeHtml(file.content)}</code></pre>`;
  } catch (error) {
    if (activeRegistrySkillId !== skillId || activeRegistryFilePath !== filePath) return;
    preview.innerHTML = `<div class="skill-file-preview-empty error"><strong>无法预览 ${escapeHtml(filePath)}</strong><p>${escapeHtml(error.message)}</p></div>`;
    if (interactive && !operatorAuthenticated) openOperatorDialog();
  }
}

function registryStatusLabel(status) {
  return ({ active: "已装备", candidate: "候选", warning: "需关注", invalid: "不可用" })[status] || status;
}

function validationStatusLabel(status) {
  return ({ passed: "验证通过", warning: "验证有提醒", failed: "验证未通过" })[status] || status;
}

function fileKindLabel(kind) {
  return ({ manifest: "SKILL", metadata: "治理", script: "脚本", reference: "参考", asset: "资产", agent: "宿主", other: "其他" })[kind] || kind;
}

function memberLabel(id) {
  const member = tribe?.members.find((candidate) => candidate.id === id);
  return member ? `${member.name} / ${id}` : id;
}

function formatFileSize(value) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
}

$("refresh-skill-registry").addEventListener("click", () => void loadSkillRegistry({ keepSelection: true, refresh: true }));

$("skill-registry-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-registry-skill]");
  if (!button) return;
  activeRegistrySkillId = button.dataset.registrySkill;
  const selected = registrySkills.find((skill) => skill.id === activeRegistrySkillId);
  const defaultFile = selected?.files.find((file) => file.path === "SKILL.md") || selected?.files[0];
  activeRegistryFilePath = defaultFile?.path;
  renderSkillRegistryList();
  renderSkillRegistryDetail(selected);
  if (skillsRoute) {
    const url = new URL(location.href);
    url.searchParams.set("skill", activeRegistrySkillId);
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
  if (matchMedia("(max-width: 760px)").matches) {
    const detail = $("skill-registry-detail");
    detail.focus({ preventScroll: true });
    detail.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }
});

$("skill-registry-detail").addEventListener("click", async (event) => {
  const file = event.target.closest("[data-skill-file]");
  if (file) {
    await loadSkillFilePreview(activeRegistrySkillId, file.dataset.skillFile, { interactive: true });
    return;
  }
  const link = event.target.closest("[data-open-skill-commission]");
  if (!link) return;
  if (!operatorAuthenticated) {
    event.preventDefault();
    $("skill-registry-live").classList.add("error");
    $("skill-registry-live").textContent = "输入操作员 Token 后才能查看委任和试炼证据";
    openOperatorDialog();
    return;
  }
  await loadSkillCommissions();
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-commission-id="${CSS.escape(link.dataset.openSkillCommission)}"]`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.setAttribute("tabindex", "-1");
      card.focus({ preventScroll: true });
    }
  });
});

function renderSkillCommissions(commissions) {
  const container = $("skill-commissions");
  if (!commissions.length) {
    container.innerHTML = '<p class="skill-empty">还没有能力委任。先用左侧对话告诉 Chief 想让谁学会什么，以及如何判断变好了。</p>';
    return;
  }
  container.innerHTML = commissions.map((commission) => {
    const pkg = commission.package;
    const acceptedTrials = commission.trials.filter((trial) => trial.outcome === "accepted").length;
    const mayContinue = ["discovering", "draft"].includes(commission.status);
    const packageDetails = pkg ? `<details>
      <summary>查看规范包与 digest</summary>
      <dl class="skill-route">
        <div><dt>Skill</dt><dd>${escapeHtml(pkg.skill_id)} v${pkg.version}</dd></div>
        <div><dt>目标成员</dt><dd>${escapeHtml(pkg.target_member_id)}</dd></div>
        <div><dt>专业服务</dt><dd>${escapeHtml(pkg.target_service_id)}</dd></div>
      </dl>
      <p class="skill-digest">SHA-256 ${escapeHtml(pkg.digest)}</p>
      <p><b>触发：</b>${escapeHtml(pkg.trigger)}</p>
      <p><b>工作方法：</b>${pkg.instructions.map(escapeHtml).join(" · ")}</p>
      <p><b>边界：</b>${pkg.boundaries.map(escapeHtml).join(" · ")}</p>
      <p><b>验收：</b>${pkg.acceptance_examples.map(escapeHtml).join(" · ")}</p>
    </details>` : "";
    const transcript = commission.messages.slice(-6).map((message) => `<div class="skill-message ${escapeHtml(message.role)}"><strong>${message.role === "chief" ? "CHIEF" : "USER"}</strong><p>${escapeHtml(message.content)}</p></div>`).join("");
    const trials = commission.trials.length
      ? `<ul class="skill-trials">${commission.trials.map((trial) => `<li>${escapeHtml(trial.outcome)} · ${escapeHtml(trial.summary)} · Reviewer ${escapeHtml(trial.reviewer_member_id)} · ${trial.metrics.baseline.total_tokens} → ${trial.metrics.trial.total_tokens} Tokens · ${trial.metrics.baseline.latency_ms} → ${trial.metrics.trial.latency_ms} ms</li>`).join("")}</ul>`
      : '<p class="chips">尚无试用证据；激活前至少需要三次独立验收。</p>';
    return `<article class="skill-commission ${escapeHtml(commission.status)}" data-commission-id="${escapeHtml(commission.id)}">
      <div class="skill-commission-head"><div><h4>${escapeHtml(commission.title)}</h4><p>${escapeHtml(commission.goal)}</p></div><span class="skill-state">${escapeHtml(skillStatusLabel(commission.status))}</span></div>
      <dl class="skill-route">
        <div><dt>Chief</dt><dd>${escapeHtml(commission.chief_member_id)}</dd></div>
        <div><dt>装备目标</dt><dd>${escapeHtml(commission.target_member_id || "澄清中")}</dd></div>
        <div><dt>风险</dt><dd>${escapeHtml(commission.risk)}</dd></div>
      </dl>
      <div class="skill-transcript">${transcript}</div>
      ${packageDetails}
      ${commission.status === "trial" || commission.status === "activation_proposed" || commission.status === "active" || commission.status === "suspended" ? trials : ""}
      ${mayContinue ? `<form class="skill-continue-form"><label>${commission.status === "discovering" ? "回答 Chief" : "继续修订草案"}<textarea name="message" required maxlength="8000" placeholder="补充边界、目标成员或可验收例子"></textarea></label><button type="submit" class="secondary">发送到同一委任</button></form>` : ""}
      ${commission.status === "trial" ? renderSkillTrialForm(commission) : ""}
      <div class="skill-actions">
        ${commission.status === "draft" ? '<button type="button" data-skill-action="validate">校验并进入试用</button>' : ""}
        ${commission.status === "trial" ? `<button type="button" data-skill-action="propose" ${acceptedTrials < 3 ? "disabled" : ""}>提议正式装备（${acceptedTrials}/3）</button>` : ""}
        ${commission.status === "activation_proposed" ? '<button type="button" data-skill-action="activate">批准装备</button>' : ""}
        ${commission.status === "active" ? '<button type="button" class="secondary" data-skill-action="rollback">回滚此版本</button>' : ""}
        ${!["active", "suspended", "cancelled"].includes(commission.status) ? '<button type="button" class="secondary" data-skill-action="cancel">取消委任</button>' : ""}
      </div>
    </article>`;
  }).join("");
}

function renderSkillTrialForm(commission) {
  const workplaces = settlement?.workplaces ?? [];
  const reviewers = (tribe?.members ?? []).filter((member) => (
    member.id !== commission.target_member_id && member.roles.includes("reviewer") && !["inactive", "retired"].includes(member.status)
  ));
  const runs = skillTrialRuns.filter((run) => run.commission_id === commission.id);
  return `<section class="skill-auto-trial">
    <div><h5>让部落完成对照试炼</h5><p>目标成员运行同一工作地与目标的基线和固定 Skill 版本，独立测试成员比较证据；不会执行 Git 提交。</p></div>
    <form class="skill-auto-trial-form" data-commission-id="${escapeHtml(commission.id)}">
      <div class="grid-two"><label>测试工作地<select name="workplace_id" required>${workplaces.length ? workplaces.map((workplace) => `<option value="${escapeHtml(workplace.id)}">${escapeHtml(workplace.name)} · ${escapeHtml(workplace.id)}</option>`).join("") : '<option value="">请先在任务大厅登记工作地</option>'}</select></label><label>独立测试成员<select name="reviewer_member_id" required>${reviewers.length ? reviewers.map((member) => `<option value="${escapeHtml(member.id)}" ${member.id === "qwen_worker" ? "selected" : ""}>${escapeHtml(member.name)} · ${escapeHtml(member.id)}</option>`).join("") : '<option value="">暂无可用 Reviewer</option>'}</select></label></div>
      <label>试炼目标<input name="goal" required maxlength="2000" value="${escapeHtml(commission.goal)}"></label>
      <div class="grid-two"><label>Git 流程<select name="mode"><option value="commit">只形成 Commit 计划</option><option value="pull_request">形成 PR 计划</option><option value="merge">形成 Merge 计划</option></select></label><label>Issue 策略<select name="issue_mode"><option value="none">不创建 Issue</option><option value="auto">按策略规划 Issue</option></select></label></div>
      <button type="submit" ${!workplaces.length || !reviewers.length ? "disabled" : ""}>开始成员试炼</button>
    </form>
    <div class="skill-trial-run-region" data-trial-runs-for="${escapeHtml(commission.id)}" aria-live="polite" aria-atomic="true">${renderSkillTrialRuns(runs)}</div>
  </section>
  <details><summary>高级：登记已有试炼证据</summary><form class="skill-trial-form" data-commission-id="${escapeHtml(commission.id)}">
    <p class="chips">先在任务大厅对同一 Git 工作地与目标运行一次基线；再把本案卷 ID <code>${escapeHtml(commission.id)}</code> 填入“试用中的 Skill Commission ID”后重跑。Token、耗时和验收结论从两份专业任务证据自动读取。</p>
    <div class="grid-two"><label>无 Skill 基线证据 ID<input name="baseline_evidence_id" required></label><label>使用 Skill 的试用证据 ID<input name="trial_evidence_id" required></label></div>
    <div class="grid-two"><label>独立 Reviewer<input name="reviewer_member_id" value="${escapeHtml(commission.chief_member_id)}" required></label><label>试用结论<select name="outcome"><option value="accepted">通过</option><option value="rejected">未通过</option></select></label></div>
    <label>Reviewer 摘要<input name="summary" required maxlength="500" placeholder="说明相对基线改善或退化的证据"></label>
    <button type="submit" class="secondary">登记试用证据</button>
  </form></details>`;
}

function skillTrialIdempotency(commissionId, input) {
  const storageKey = `totemora_skill_trial:${commissionId}`;
  const signature = JSON.stringify(input);
  try {
    const existing = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (existing?.signature === signature && existing?.key) return { storageKey, key: existing.key };
  } catch {}
  const key = crypto.randomUUID();
  sessionStorage.setItem(storageKey, JSON.stringify({ signature, key }));
  return { storageKey, key };
}

function renderSkillTrialRuns(runs) {
  if (!runs.length) return '<p class="skill-trial-run-empty">还没有自动试炼。一次试炼会留下目标成员、Reviewer、两份 Evidence ID 和结论。</p>';
  return `<ol class="skill-trial-runs" aria-label="自动试炼进度">${runs.map((run) => { const outcome = run.review?.outcome; return `<li class="${escapeHtml(outcome || run.status)}"><div><strong>${escapeHtml(outcome === "accepted" ? "试炼通过" : outcome === "rejected" ? "试炼未通过" : skillTrialStageLabel(run.stage))}</strong><span>${escapeHtml(outcome || run.status)}</span></div><p>${escapeHtml(run.review?.rationale || run.error || `${memberLabel(run.target_member_id)} 正在与 ${memberLabel(run.reviewer_member_id)} 协作`)}</p><small>${escapeHtml(formatObservatoryTime(run.updated_at))}${run.baseline_evidence_id ? ` · 基线 <code>${escapeHtml(run.baseline_evidence_id)}</code>` : ""}${run.trial_evidence_id ? ` · 试用 <code>${escapeHtml(run.trial_evidence_id)}</code>` : ""}</small></li>`; }).join("")}</ol>`;
}

function skillTrialStageLabel(stage) {
  return ({ queued: "等待成员", baseline: "运行无新 Skill 基线", trial: "运行固定版本试用", review: "独立测试成员验收", record: "Chief 登记证据", completed: "试炼已登记", failed: "试炼失败" })[stage] || stage;
}

function skillStatusLabel(status) {
  return ({
    discovering: "澄清中", draft: "草案", trial: "试用中",
    activation_proposed: "等待装备审批", active: "已装备",
    superseded: "已被新版本取代", suspended: "已回滚", cancelled: "已取消",
  })[status] || status;
}

$("skill-commission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("skill-commission-status").textContent = "Chief 正在澄清这项能力委任…";
  try {
    const commission = await operatorApi("/api/skills/commissions", {
      method: "POST", body: JSON.stringify({ message: $("skill-commission-message").value }),
    });
    $("skill-commission-message").value = "";
    $("skill-commission-status").textContent = commission.status === "discovering"
      ? "Chief 已提出澄清问题，请在案卷中继续对话。"
      : "Chief 已形成草案，请检查后进入试用。";
    await loadSkillCommissions();
  } catch (error) {
    $("skill-commission-status").textContent = `委任失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$("refresh-skills").addEventListener("click", () => void loadSkillCommissions());

$("skill-commissions").addEventListener("submit", async (event) => {
  const card = event.target.closest("[data-commission-id]");
  if (!card) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    if (form.classList.contains("skill-continue-form")) {
      await operatorApi(`/api/skills/commissions/${encodeURIComponent(card.dataset.commissionId)}/messages`, {
        method: "POST", body: JSON.stringify({ message: new FormData(form).get("message") }),
      });
    } else if (form.classList.contains("skill-auto-trial-form")) {
      const data = new FormData(form);
      const trialInput = {
        workplace_id: data.get("workplace_id"), goal: data.get("goal"),
        reviewer_member_id: data.get("reviewer_member_id"), mode: data.get("mode"), issue_mode: data.get("issue_mode"),
      };
      const idempotency = skillTrialIdempotency(card.dataset.commissionId, trialInput);
      const run = await operatorApi(`/api/skills/commissions/${encodeURIComponent(card.dataset.commissionId)}/run-trial`, {
        method: "POST", body: JSON.stringify({
          idempotency_key: idempotency.key, ...trialInput,
        }),
      });
      $("skill-commission-status").textContent = "成员试炼已开始：目标成员先跑基线，再加载固定 Skill，由独立 Reviewer 验收。";
      await waitForSkillTrialRun(run.id);
      sessionStorage.removeItem(idempotency.storageKey);
    } else if (form.classList.contains("skill-trial-form")) {
      const data = new FormData(form);
      await operatorApi(`/api/skills/commissions/${encodeURIComponent(card.dataset.commissionId)}/trials`, {
        method: "POST", body: JSON.stringify({
          baseline_evidence_id: data.get("baseline_evidence_id"),
          trial_evidence_id: data.get("trial_evidence_id"),
          reviewer_member_id: data.get("reviewer_member_id"),
          outcome: data.get("outcome"), summary: data.get("summary"),
        }),
      });
    }
    await loadSkillCommissions();
  } catch (error) {
    $("skill-commission-status").textContent = `能力委任操作失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

async function waitForSkillTrialRun(id) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const run = await operatorApi(`/api/skills/trial-runs/${encodeURIComponent(id)}`);
    const existing = skillTrialRuns.findIndex((candidate) => candidate.id === run.id);
    if (existing >= 0) skillTrialRuns[existing] = run;
    else skillTrialRuns.unshift(run);
    const region = [...document.querySelectorAll("[data-trial-runs-for]")]
      .find((candidate) => candidate.dataset.trialRunsFor === run.commission_id);
    if (region) region.innerHTML = renderSkillTrialRuns(
      skillTrialRuns.filter((candidate) => candidate.commission_id === run.commission_id),
    );
    if (["completed", "failed"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("成员试炼仍在运行，请稍后刷新查看");
}

$("skill-commissions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-skill-action]");
  const card = button?.closest("[data-commission-id]");
  if (!button || !card) return;
  const action = button.dataset.skillAction;
  const paths = {
    validate: "validate", propose: "propose-activation", activate: "activate",
    rollback: "rollback", cancel: "cancel",
  };
  button.disabled = true;
  try {
    await operatorApi(`/api/skills/commissions/${encodeURIComponent(card.dataset.commissionId)}/${paths[action]}`, {
      method: "POST", body: JSON.stringify(action === "activate" ? { approved_by: "operator" } : action === "rollback" ? { reviewed_by: "operator" } : {}),
    });
    await loadSkillCommissions();
  } catch (error) {
    $("skill-commission-status").textContent = `能力委任操作失败：${error.message}`;
    button.disabled = false;
  }
});

async function loadAssets() {
  const { assets } = await api("/api/assets");
  $("assets").innerHTML = assets.map((asset) => {
    const grants = asset.authorized_members.map((member) => escapeHtml(member.name)).join(" · ") || "尚未授予成员";
    const evidence = asset.evidence.length
      ? `${asset.evidence.length} 条已验证流程 · 最近 ${escapeHtml(asset.evidence[0].workflow_id)}`
      : `${asset.usage_count} 次调用 · 尚无完成态流程证据`;
    return `<article class="asset-card ${escapeHtml(asset.maturity)}">
      <div class="asset-meta"><span>${escapeHtml(asset.kind)}</span><b>${escapeHtml(asset.maturity)}</b></div>
      <h3>${escapeHtml(asset.name)} <small>v${asset.version}</small></h3>
      <p>${escapeHtml(asset.summary)}</p>
      <dl><dt>执行器</dt><dd>${escapeHtml(asset.executor)}</dd><dt>风险 / 默认</dt><dd>${escapeHtml(asset.risk)} / ${escapeHtml(asset.default_access)}</dd><dt>授权成员</dt><dd>${grants}</dd></dl>
      <div class="chips">能力 / ${asset.actions.map(escapeHtml).join(" · ") || "仅候选图纸"}<br>策略 / ${asset.policy_requirements.map(escapeHtml).join(" · ")}</div>
      <div class="asset-evidence">${evidence}</div>
      <small>图纸：${escapeHtml(asset.blueprint.source)} · ${escapeHtml(asset.blueprint.notes)}</small>
    </article>`;
  }).join("");
}

async function loadEmbers() {
  const { embers } = await api("/api/embers");
  $("embers").innerHTML = embers.map((ember) => `<article class="ember-card ${escapeHtml(ember.status)}">
    <div class="provider">${escapeHtml(ember.provider_id)} · ${escapeHtml(ember.provider_type)}</div>
    <h3>${escapeHtml(ember.model)}</h3>
    <p>${ember.status === "available" ? "火种可用" : "当前休眠"} · 凭据来自 ${escapeHtml(ember.config_source)}</p>
    <div class="chips">已孵化 / ${ember.member_ids.map(escapeHtml).join(" · ")}</div>
  </article>`).join("");
}

function renderCodex() {
  const members = tribe.members.filter((member) => !["inactive", "retired"].includes(member.status));
  $("codex").innerHTML = members.map((member) => {
    const profile = Object.entries(member.profile).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return `<article class="codex-card" data-mark="${escapeHtml(member.name.slice(0, 1))}">
      <div class="portrait">${escapeHtml(member.name.slice(0, 1))}</div>
      <h3>${escapeHtml(member.name)}</h3><div class="model">${escapeHtml(member.model)} · ${escapeHtml(member.roles.join(" / "))}</div>
      <p class="story">${escapeHtml(member.persona)}</p>
      ${profile.map(([name, score]) => `<div class="profile-row"><span>${escapeHtml(name)}</span><i><b style="width:${Math.round(score * 100)}%"></b></i><em>${Math.round(score * 100)}</em></div>`).join("")}
      <div class="chips">火种 / ${escapeHtml(member.ember_id)}<br>Skills / ${member.skills.map(escapeHtml).join(" · ") || "尚未装备"}</div>
    </article>`;
  }).join("");
}

async function loadMemberDossiers() {
  const result = await api("/api/members/dossiers");
  memberDossiers = result.members.filter((item) => !["inactive", "retired"].includes(item.member.status));
  activeMemberId ||= memberDossiers[0]?.member.id;
  $("member-tabs").innerHTML = memberDossiers.map((item) => `<button type="button" class="member-tab ${item.member.id === activeMemberId ? "active" : ""}" data-member="${escapeHtml(item.member.id)}">
    <b>${escapeHtml(item.member.name || item.member.id)}</b><small>${escapeHtml(item.identity.rank)} · ${escapeHtml(item.member.status || "active")}</small>
  </button>`).join("");
  $("member-tabs").querySelectorAll("[data-member]").forEach((button) => button.addEventListener("click", () => {
    activeMemberId = button.dataset.member; void loadMemberDossiers();
  }));
  const dossier = memberDossiers.find((item) => item.member.id === activeMemberId);
  if (!dossier) return;
  const mentor = dossier.identity.mentor ? `${escapeHtml(dossier.identity.mentor.name)}（${escapeHtml(dossier.identity.mentor.id)}）` : "无固定导师";
  const portrait = dossier.portrait;
  $("member-dossier").innerHTML = `<h3>${escapeHtml(dossier.member.name || dossier.member.id)}</h3>
    <p>${escapeHtml(dossier.member.persona || "")}</p>
    <dl><dt>谱系</dt><dd>${escapeHtml(dossier.identity.discipline)} / ${escapeHtml(dossier.identity.rank)}</dd><dt>导师</dt><dd>${mentor}</dd><dt>年龄</dt><dd>${dossier.identity.age_days} 天</dd><dt>活力</dt><dd>${Math.round(dossier.growth.vitality * 100)}%</dd></dl>
    <div class="chips">经验信用 ${dossier.growth.experience_credit} · 可信结果 ${dossier.growth.verified_successes} · 日常操作 ${dossier.growth.operation_count} · 成员失败 ${dossier.growth.failures} · 系统失败 ${dossier.growth.system_failures || 0}</div>
    <h4>性格内核 · v${portrait.constitution.version}</h4>
    <p><b>特质</b> ${portrait.constitution.traits.map(escapeHtml).join(" · ") || "尚未结构化"}</p>
    <p><b>原则</b> ${portrait.constitution.principles.map(escapeHtml).join(" · ") || "尚未结构化"}</p>
    <p><b>表达</b> ${portrait.constitution.communication_style.map(escapeHtml).join(" · ") || "尚未结构化"}</p>
    <p><b>工作偏好</b> ${portrait.constitution.working_preferences.map(escapeHtml).join(" · ") || "尚未结构化"}</p>
    <h4>观察画像</h4>${portrait.observed_traits.map((item) => `<p>${escapeHtml(item.name)} ${Math.round(item.score * 100)} <small>置信 ${Math.round(item.confidence * 100)} · ${escapeHtml(item.evidence)}</small></p>`).join("")}
    <h4>任务履历</h4><p>完成 ${portrait.task_record.completed} · 验收成功 ${portrait.task_record.accepted} · 经验信用 ${portrait.task_record.experience_credit} · 成功率 ${Math.round(portrait.task_record.success_rate * 100)}%</p>
    <h4>重大经历</h4>${portrait.major_experiences.map((item) => `<p class="memory verified"><b>${escapeHtml(item.title)}</b> ${escapeHtml(item.summary.length > 260 ? `${item.summary.slice(0, 260)}…` : item.summary)}<small>${escapeHtml(item.at)}</small></p>`).join("") || "<small>尚无重大经历</small>"}
    <h4>成长提案</h4>${portrait.evolution.pending.map((item) => `<article class="memory"><b>${escapeHtml(item.rationale)}</b><p><strong>建议改动</strong> ${escapeHtml(Object.entries(item.proposed_changes).map(([field, values]) => `${field}: ${(values || []).join(" · ")}`).join("；"))}</p><p><strong>预期收益</strong> ${escapeHtml(item.expected_benefit)}</p><p><strong>风险</strong> ${item.risks.map(escapeHtml).join(" · ")}</p><small>由 ${escapeHtml(item.proposed_by)} 提出 · 基于 v${item.base_version}</small><div><button type="button" data-evolution="approve" data-proposal="${escapeHtml(item.id)}">批准升级</button><button type="button" class="secondary" data-evolution="reject" data-proposal="${escapeHtml(item.id)}">拒绝</button></div></article>`).join("") || "<small>当前没有待审提案</small>"}
    ${portrait.evolution.active_effect ? `<p class="evolution-effect"><b>上次成长已实际生效</b><br>v${portrait.evolution.active_effect.before_version} → v${portrait.evolution.active_effect.after_version}；下一次任务起，提示词使用新的 ${portrait.evolution.active_effect.changed_fields.map(escapeHtml).join("、")}。当前处于 ${escapeHtml(portrait.evolution.active_effect.evaluation_status)}，已观察 ${portrait.evolution.active_effect.observed_experience_credit || 0} / ${portrait.evolution.active_effect.target_credited_tasks} 份经验信用；基线为 ${portrait.evolution.active_effect.baseline.experience_credit} 信用、${portrait.evolution.active_effect.baseline.member_failures} 次成员失败。</p>` : ""}
    ${portrait.evolution.pending.length ? "<small>正式画像保持当前版本，等待提案处理。</small>" : dossier.growth.eligible_growth_proposal ? '<button type="button" class="secondary" id="generate-evolution">请导师提出成长建议</button>' : `<small>距下次成长评审还需 ${dossier.growth.next_review_after_runs} 份经验信用${dossier.growth.review_cooldown_days ? `；冷却还剩 ${dossier.growth.review_cooldown_days} 天` : ""}</small>`}
    <h4>最近经历</h4>${dossier.experiences.slice(0, 6).map((item) => `<p class="memory ${item.verified ? "verified" : ""}"><b>${escapeHtml(item.kind)}</b> ${escapeHtml(item.summary)}<small>${escapeHtml(item.at)}</small></p>`).join("") || "<small>尚未留下经历</small>"}`;
  $("generate-evolution")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try { await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/evolution/proposals`, { method: "POST", body: "{}" }); await loadMemberDossiers(); }
    catch (error) { alert(error.message); event.currentTarget.disabled = false; }
  });
  $("member-dossier").querySelectorAll("[data-evolution]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/evolution/proposals/${encodeURIComponent(button.dataset.proposal)}/review`, {
        method: "POST", body: JSON.stringify({ approve: button.dataset.evolution === "approve", reviewer_id: dossier.identity.mentor?.id || tribe.tribe.chief }),
      });
      await loadMemberDossiers();
    } catch (error) { alert(error.message); button.disabled = false; }
  }));
  await loadMemberConversation();
}

async function loadMemberConversation() {
  if (!activeMemberId) return;
  const { messages } = await api(`/api/members/${encodeURIComponent(activeMemberId)}/messages`);
  $("member-conversation").innerHTML = messages.slice(-30).map((item) => `<article class="chat-message ${escapeHtml(item.role)}"><small>${escapeHtml(item.author_id)} · ${escapeHtml(item.role)}</small><p>${escapeHtml(item.content)}</p></article>`).join("") || "<p class=\"section-note\">营帐还没有对话。</p>";
  $("member-conversation").scrollTop = $("member-conversation").scrollHeight;
}

$("member-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeMemberId) return;
  const button = event.submitter; button.disabled = true;
  try {
    await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/chat`, {
      method: "POST", body: JSON.stringify({ message: $("member-message").value, ask_mentor: $("ask-mentor").checked }),
    });
    $("member-message").value = ""; $("ask-mentor").checked = false;
    await loadMemberDossiers();
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; }
});

async function loadIntelligence() {
  const [{ briefs }, pool] = await Promise.all([api("/api/intelligence"), api("/api/intelligence/candidates")]);
  renderCandidatePool(pool, "candidate-summary", "intelligence-candidates");
  renderBriefs(briefs, "intelligence-history", "听风尚未带回情报。");
  if (operatorAuthenticated) {
    try {
      const bark = await operatorApi("/api/intelligence/bark?health=1");
      renderBarkStatus("bark-status", bark, "AI");
    } catch (error) {
      $("bark-status").className = "channel-status error";
      $("bark-status").textContent = `Bark 状态读取失败：${error.message}`;
    }
  } else {
    $("bark-status").textContent = "输入操作员 Token 后可检查内部 Bark 健康状态";
  }
}

function renderCandidatePool(pool, summaryId, containerId) {
  $(summaryId).textContent = `待推送 ${pool.counts.queued || 0} · 重试 ${pool.counts.retry_wait || 0} · 通道阻塞 ${pool.counts.channel_blocked || 0} · 投递未知 ${pool.counts.delivery_unknown || 0} · 抑制 ${pool.counts.held || 0} · 已推送 ${pool.counts.pushed || 0} · 失败 ${pool.counts.failed || 0}`;
  $(containerId).innerHTML = pool.candidates.slice(0, 6).map((item) => {
    const evidence = [item.evidence_tier, item.market, ...(item.symbols || []), item.event_type].filter(Boolean).map(escapeHtml).join(" · ");
    return `<article class="brief ${escapeHtml(item.status)}" data-candidate="${escapeHtml(item.id)}"><h3>${externalLink(item.url, item.headline)}</h3><p>${escapeHtml(item.brief)}</p><div class="chips">${evidence ? `${evidence} · ` : ""}${escapeHtml(item.status)} · 总分 ${Math.round(item.scores.total * 100)}（模型 ${Math.round((item.scores.base_total ?? item.scores.total) * 100)} / 反馈 ${Math.round((item.scores.feedback_adjustment || 0) * 100)}） · 可信 ${Math.round(item.scores.confidence * 100)}</div><small>${escapeHtml(item.decision)} · ${escapeHtml(item.rationale)}</small><div class="candidate-feedback" role="group" aria-label="评价这条候选消息"><button type="button" data-feedback="valuable">有价值 ${item.feedback?.valuable || ""}</button><button type="button" data-feedback="not_valuable">没价值 ${item.feedback?.not_valuable || ""}</button><button type="button" data-feedback="duplicate">重复 ${item.feedback?.duplicate || ""}</button><button type="button" data-feedback="too_late">太晚 ${item.feedback?.too_late || ""}</button></div><small class="feedback-status" aria-live="polite">${item.feedback?.opened ? `Bark 已打开 ${item.feedback.opened} 次；这是高置信正向证据` : "未反馈不会扣分；主动反馈才会校正后续相似消息"}</small></article>`;
  }).join("") || "<p class=\"section-note\">候选池为空。可以立即扫描；失败原因会留在扫描记录中。</p>";
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

async function loadBarkTargets() {
  const summary = $("bark-target-summary");
  if (!operatorAuthenticated) {
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
    const state = !target.enabled
      ? { className: "disabled", label: "已停用" }
      : target.healthy === false
        ? { className: "attention", label: "健康检查失败" }
        : target.channel_status === "ready"
          ? { className: "ready", label: "可投递" }
          : { className: "attention", label: target.channel_status === "open" ? "熔断等待" : "通道降级" };
    const source = target.source === "legacy" ? "旧主设备" : target.source === "environment" ? "环境配置" : "面板管理";
    const managed = target.source === "managed" && status.write_enabled;
    return `<article class="notification-target ${state.className}" data-bark-target="${escapeHtml(target.id)}">
      <div class="notification-target-head"><div><h5>${escapeHtml(target.label || target.id)}</h5><small>${escapeHtml(target.id)} · ${source}</small></div><span class="notification-target-state">${state.label}</span></div>
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
    if (["需要操作员 Token", "设备状态不可用", "当前配置只读"].includes(statusNode.textContent)) {
      statusNode.textContent = "";
    }
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

$("refresh-bark-targets").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try { await loadBarkTargets(); }
  finally { event.currentTarget.disabled = false; }
});

$("cancel-bark-edit").addEventListener("click", () => {
  resetBarkTargetForm();
  $("bark-target-form-status").textContent = "已取消编辑";
});

$("bark-target-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const statusNode = $("bark-target-form-status");
  const domains = [$("bark-domain-ai").checked && "ai", $("bark-domain-finance").checked && "finance"].filter(Boolean);
  if (!domains.length) { statusNode.classList.add("error"); statusNode.textContent = "至少选择一个接收领域"; return; }
  button.disabled = true;
  statusNode.classList.remove("error");
  statusNode.textContent = editingBarkTargetId ? "正在更新设备路由…" : "正在安全写入设备配置…";
  const id = editingBarkTargetId || $("bark-target-id").value.trim();
  try {
    const payload = {
      id, label: $("bark-target-label").value.trim(),
      device_key: $("bark-target-key").value.trim() || undefined,
      server_url: $("bark-target-server").value.trim(), domains,
      enabled: $("bark-target-enabled").checked,
    };
    await operatorApi(editingBarkTargetId
      ? `/api/notifications/bark/targets/${encodeURIComponent(id)}`
      : "/api/notifications/bark/targets", {
      method: editingBarkTargetId ? "PUT" : "POST", body: JSON.stringify(payload),
    });
    resetBarkTargetForm();
    statusNode.textContent = "设备配置已保存并即时生效，无需重启 Gateway";
    await Promise.all([loadBarkTargets(), loadIntelligence(), loadFinance()]);
  } catch (error) {
    statusNode.classList.add("error");
    statusNode.textContent = `保存失败：${error.message}`;
  } finally { button.disabled = false; }
});

$("bark-target-list").addEventListener("click", async (event) => {
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
        method: "PUT", body: JSON.stringify({ enabled: !target.enabled }),
      });
      feedback.textContent = target.enabled ? "设备已停用；候选与其他设备不受影响" : "设备已启用并即时加入路由";
    } else {
      feedback.textContent = "正在发送测试通知…";
      await operatorApi(`/api/notifications/bark/targets/${encodeURIComponent(target.id)}/test`, {
        method: "POST", body: JSON.stringify({ idempotency_key: `web-bark-test:${target.id}:${Date.now()}` }),
      });
      feedback.textContent = "Bark 服务已接受测试；请检查手机通知";
    }
    await Promise.all([loadBarkTargets(), loadIntelligence(), loadFinance()]);
  } catch (error) {
    feedback.classList.add("error");
    feedback.textContent = `${button.matches("[data-bark-toggle]") ? "更新" : "测试"}失败：${error.message}`;
  } finally { button.disabled = false; }
});

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
      method: "POST", body: JSON.stringify({ signal: button.dataset.feedback }),
    });
    statusNode.textContent = result.inserted ? "反馈已记录；下一轮相似消息评估会使用这条证据" : "这条反馈已记录过，没有重复计权";
    await Promise.all([loadIntelligence(), loadFinance(), loadMemberDossiers()]);
  } catch (error) {
    statusNode.classList.add("error");
    statusNode.textContent = `反馈失败：${error.message}。可再次点击重试。`;
    card.querySelectorAll("[data-feedback]").forEach((item) => { item.disabled = false; });
  }
}

$("intelligence-candidates").addEventListener("click", handleCandidateFeedback);
$("finance-candidates").addEventListener("click", handleCandidateFeedback);

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

$("intelligence-preferences").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    await operatorApi("/api/intelligence/preferences", { method: "PUT", body: JSON.stringify({
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
    }) });
    $("intelligence-preference-status").textContent = "偏好已保存；下一轮巡查生效";
  } catch (error) { $("intelligence-preference-status").textContent = error.message; }
  finally { button.disabled = false; }
});

$("run-intelligence").addEventListener("click", async () => {
  const button = $("run-intelligence"); button.disabled = true; $("intelligence-status").classList.remove("error"); $("intelligence-status").textContent = "听风正在扫描、聚类并评估候选消息…";
  try {
    const task = await operatorApi("/api/intelligence/tasks", {
      method: "POST", body: JSON.stringify({ message_count: 3, delivery_mode: "candidate_pool", idempotency_key: `web-scan-${Date.now()}` }),
    });
    let current = task;
    while (!["completed", "failed"].includes(current.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = await operatorApi(`/api/intelligence/tasks/${encodeURIComponent(task.id)}`);
      $("intelligence-status").textContent = `听风任务 ${current.status}…`;
    }
    if (current.status === "failed") throw new Error(current.error || "情报任务失败");
    const brief = current.result;
    const growth = current.growth_review?.status === "proposed" ? "；导师已生成成长提案" : "";
    $("intelligence-status").textContent = `扫描完成：${brief.title}，形成 ${brief.candidate_ids?.length || 0} 条候选，${brief.queued_messages || 0} 条进入推送队列${growth}`;
    await Promise.all([loadIntelligence(), loadMemberDossiers(), loadAssets()]);
  } catch (error) { $("intelligence-status").textContent = error.message; $("intelligence-status").classList.add("error"); }
  finally { button.disabled = false; }
});

async function loadFinance() {
  const [{ briefs }, pool, { sources }] = await Promise.all([
    api("/api/finance"), api("/api/finance/candidates"), api("/api/finance/sources"),
  ]);
  renderCandidatePool(pool, "finance-candidate-summary", "finance-candidates");
  renderBriefs(briefs, "finance-history", "观潮尚未完成首次巡查。");
  $("finance-source-ledger").innerHTML = sources.map((source) => `<div class="source-row"><strong>${externalLink(source.url, source.name)}</strong><span class="source-state ${escapeHtml(source.status)}">${escapeHtml(source.tier)} · ${escapeHtml(source.status)}</span><p>${escapeHtml(source.summary)}</p><small>${source.last_success_at ? `上次成功 ${escapeHtml(source.last_success_at)}` : escapeHtml(source.error || "等待接入")}</small><small>${escapeHtml(source.availability)}</small></div>`).join("");
  if (operatorAuthenticated) {
    try { renderBarkStatus("finance-bark-status", await operatorApi("/api/finance/bark?health=1"), "财经"); }
    catch (error) {
      $("finance-bark-status").className = "channel-status error";
      $("finance-bark-status").textContent = `财经 Bark 状态读取失败：${error.message}`;
    }
  } else {
    $("finance-bark-status").textContent = "输入操作员 Token 后可检查财经 Bark 设备路由";
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

function readFinanceWatchlist() {
  return $("finance-watchlist").value.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const match = line.match(/^(CN|HK|US|JP|KR):([^\s]+)(?:\s+(.+))?$/i);
    if (!match) throw new Error(`自选清单第 ${index + 1} 行格式不正确`);
    return { market: match[1].toUpperCase(), symbol: match[2].toUpperCase(), name: match[3]?.trim() || undefined };
  });
}

$("finance-preferences").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    const markets = [["CN", "market-cn"], ["HK", "market-hk"], ["US", "market-us"], ["JP", "market-jp"], ["KR", "market-kr"]].filter(([, id]) => $(id).checked).map(([market]) => market);
    await operatorApi("/api/finance/preferences", { method: "PUT", body: JSON.stringify({
      interests: $("finance-interests").value.split("\n").map((item) => item.trim()).filter(Boolean),
      watchlist: readFinanceWatchlist(), markets,
      channels: {
        disclosures: $("finance-disclosures").checked, regulation: $("finance-regulation").checked,
        macro: $("finance-macro").checked, global_official: $("finance-global").checked,
        market_media: $("finance-market-media").checked,
      },
      scan_interval_minutes: Number($("finance-scan-interval").value),
      push_interval_seconds: Number($("finance-push-interval").value),
      push_threshold: Number($("finance-push-threshold").value), novelty_history_hours: 168,
      morning_briefings: {
        timezone: "Asia/Shanghai",
        asia_preopen: { enabled: $("finance-asia-brief-enabled").checked, time: $("finance-asia-brief-time").value },
        us_overnight: { enabled: $("finance-us-brief-enabled").checked, time: $("finance-us-brief-time").value },
      },
    }) });
    $("finance-preference-status").textContent = "范围已保存；观潮下一轮巡查生效";
    await loadFinance();
  } catch (error) { $("finance-preference-status").textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelectorAll("[data-finance-briefing]").forEach((button) => button.addEventListener("click", async () => {
  const briefingType = button.dataset.financeBriefing;
  button.disabled = true;
  $("finance-status").classList.remove("error");
  $("finance-status").textContent = "观潮正在采集结构化行情、新闻证据并生成测试晨报…";
  try {
    const task = await operatorApi("/api/finance/tasks", {
      method: "POST", body: JSON.stringify({
        message_count: 1, delivery_mode: "direct_push", briefing_type: briefingType,
        idempotency_key: `web-finance-${briefingType}-${Date.now()}`,
      }),
    });
    let current = task;
    while (!["completed", "failed"].includes(current.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = await operatorApi(`/api/finance/tasks/${encodeURIComponent(task.id)}`);
      $("finance-status").textContent = `晨报任务 ${current.status}…`;
    }
    if (current.status === "failed") throw new Error(current.error || "财经晨报任务失败");
    $("finance-status").textContent = `${current.result.title} 已完成，向财经设备发送 ${current.result.pushed_messages || 0} 条`;
    await Promise.all([loadFinance(), loadMemberDossiers(), loadAssets()]);
  } catch (error) {
    $("finance-status").textContent = error.message;
    $("finance-status").classList.add("error");
  } finally { button.disabled = false; }
}));

$("run-finance").addEventListener("click", async () => {
  const button = $("run-finance"); button.disabled = true; $("finance-status").classList.remove("error"); $("finance-status").textContent = "观潮正在读取权威来源与市场线索、核对事件并评估候选…";
  try {
    const task = await operatorApi("/api/finance/tasks", {
      method: "POST", body: JSON.stringify({ message_count: 5, delivery_mode: "candidate_pool", idempotency_key: `web-finance-${Date.now()}` }),
    });
    let current = task;
    while (!["completed", "failed"].includes(current.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = await operatorApi(`/api/finance/tasks/${encodeURIComponent(task.id)}`);
      $("finance-status").textContent = `观潮任务 ${current.status}…`;
    }
    if (current.status === "failed") throw new Error(current.error || "财经情报任务失败");
    const brief = current.result;
    $("finance-status").textContent = `扫描完成：${brief.title}，形成 ${brief.candidate_ids?.length || 0} 条候选，${brief.queued_messages || 0} 条进入推送队列`;
    await Promise.all([loadFinance(), loadMemberDossiers(), loadAssets()]);
  } catch (error) { $("finance-status").textContent = error.message; $("finance-status").classList.add("error"); }
  finally { button.disabled = false; }
});

async function loadContentStudio() {
  const [preferences, pool] = await Promise.all([
    api("/api/content/preferences"), api("/api/intelligence/candidates"),
  ]);
  $("content-schedule-enabled").checked = preferences.enabled;
  $("content-min-hours").value = preferences.min_interval_hours;
  $("content-max-hours").value = preferences.max_interval_hours;
  $("content-schedule-x").checked = preferences.formats.includes("x_hot_post");
  $("content-schedule-long").checked = preferences.formats.includes("longform_tutorial");
  $("content-schedule-status").textContent = preferences.enabled
    ? `下一次窗口：${preferences.next_run_at ? new Date(preferences.next_run_at).toLocaleString() : "等待排期"}`
    : "自动创作已暂停；手动创作仍可使用";
  $("content-candidate").innerHTML = '<option value="">自动选择高可信候选</option>' + pool.candidates
    .filter((item) => item.scores.confidence >= 0.6)
    .slice(0, 30)
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.headline)} · ${Math.round(item.scores.total * 100)}分</option>`).join("");
  if (!operatorAuthenticated) {
    contentWorks = [];
    $("content-summary").textContent = "输入操作员 Token 后查看未发布作品与配图";
    $("content-works").innerHTML = '<div class="content-empty"><b>创作证据已保护</b><p>作品正文、提示词、失败原因和配图只对操作员开放。</p></div>';
    return;
  }
  contentWorks = (await operatorApi("/api/content/works")).works;
  renderContentWorks();
}

function renderContentWorks() {
  const format = $("content-filter-format").value;
  const status = $("content-filter-status").value;
  const active = ["queued", "researching", "drafting", "reviewing"];
  const filtered = contentWorks.filter((work) => (format === "all" || work.format === format)
    && (status === "all" || work.status === status || (status === "active" && active.includes(work.status))));
  const ready = contentWorks.filter((work) => work.status === "ready").length;
  const illustrated = contentWorks.filter((work) => work.illustration?.status === "ready").length;
  $("content-summary").textContent = `${contentWorks.length} 份作品 · ${ready} 份可复制 · ${illustrated} 份已有配图`;
  $("content-works").innerHTML = filtered.map((work) => {
    const formatLabel = work.format === "x_hot_post" ? "X 热点短帖" : "教程 / 经验长文";
    const statusLabel = ({ queued: "等待召集", researching: "选题研究", drafting: "撰写中", reviewing: "协作审校", ready: "可复制", failed: "未通过" })[work.status] || work.status;
    const members = work.assignments.map((item) => {
      const member = tribe?.members.find((entry) => entry.id === item.member_id);
      const role = item.role === "writer" ? "执笔" : item.role === "illustrator" ? "视觉策划 / 配图" : "研究 / 审校";
      return `<span><b>${escapeHtml(member?.name || item.member_id)}</b> · ${role}</span>`;
    }).join("");
    const contributions = work.contributions.map((item) => `<li><b>${escapeHtml(item.member_name)}</b> · ${escapeHtml(item.summary)}</li>`).join("");
    const illustration = work.illustration;
    const illustrationLabel = ({ pending: "等待绘影", briefing: "视觉简报中", generating: "配图生成中", reviewing: "视觉验收中", ready: "配图已就绪", failed: "配图未通过" })[illustration?.status] || "未启用配图";
    const illustrationBlock = illustration ? `<section class="content-illustration ${escapeHtml(illustration.status)}">
      <header><b>${escapeHtml(illustrationLabel)}</b><small>${illustration.image_model ? `${escapeHtml(illustration.image_model)} · ${illustration.attempt_count} 次尝试` : "绘影正在把文章语义翻译成画面"}</small></header>
      ${illustration.status === "ready" ? `<div class="illustration-placeholder" data-content-illustration="${escapeHtml(work.id)}" data-alt="${escapeHtml(illustration.brief?.alt_text || `《${work.title || work.topic}》文章配图`)}" role="status">正在安全读取配图…</div><div class="illustration-evidence"><span>${illustration.width} × ${illustration.height}</span><span>语义 ${Math.round((illustration.review?.semantic_score || 0) * 100)}%</span><span>风格 ${Math.round((illustration.review?.style_score || 0) * 100)}%</span><span>线稿 ${Math.round((illustration.review?.line_quality_score || 0) * 100)}%</span></div>` : `<p>${escapeHtml(illustration.error || illustration.brief?.alt_text || "绘影正在工作，正文不会因图片失败而丢失")}</p>`}
      ${illustration.status === "failed" ? '<button type="button" class="secondary" data-retry-illustration>重新召集绘影</button>' : ""}
    </section>` : "";
    return `<article class="content-work ${escapeHtml(work.status)}" data-content-work="${escapeHtml(work.id)}">
      <header class="content-work-head"><div><span class="content-kind">${formatLabel}</span><h4>${escapeHtml(work.title || work.topic)}</h4></div><span class="content-state">${escapeHtml(statusLabel)}</span></header>
      <div class="content-lineage">${members}</div>
      ${work.body ? `<details class="content-draft"><summary>查看正文 · ${[...work.body].length} 字</summary><pre class="content-body">${escapeHtml(work.body)}</pre></details>` : `<div class="content-progress"><i></i><span>${escapeHtml(work.error || "成员正在工作，页面会自动刷新进度")}</span></div>`}
      ${illustrationBlock}
      <div class="content-source"><span>来源</span>${work.source.url ? `<a href="${escapeHtml(work.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(work.source.headline)}</a>` : `<b>${escapeHtml(work.source.headline)} · 用户选题</b>`}</div>
      <details><summary>协作证据 · ${work.contributions.length} 条</summary><ol class="content-contributions">${contributions || "<li>Chief 已完成路由，等待成员贡献</li>"}</ol>${work.review ? `<p>审校：${escapeHtml(work.review.outcome)} · ${escapeHtml(work.review.rationale)}</p>` : ""}</details>
      <footer><small>v${work.revision} · ${work.usage.calls} 次模型调用 · ${work.usage.total_tokens || 0} Tokens · 已复制 ${work.copy_count} 次</small><div class="content-actions">${illustration?.status === "ready" ? '<button type="button" class="secondary" data-download-illustration>下载配图</button>' : ""}${work.status === "ready" ? '<button type="button" data-copy-content>复制正文</button>' : ""}</div></footer>
      <small class="copy-status" aria-live="polite">${work.status === "ready" ? "复制行为会作为用户采纳信号记入参与成员的经历" : work.error ? escapeHtml(work.error) : ""}</small>
    </article>`;
  }).join("") || '<div class="content-empty"><b>还没有符合条件的作品</b><p>从左侧选择一个情报候选，召集听风与千工完成第一份双人协作内容。</p></div>';
  void hydrateContentIllustrations();
}

async function hydrateContentIllustrations() {
  await Promise.all([...document.querySelectorAll("[data-content-illustration]")].map(async (placeholder) => {
    const id = placeholder.dataset.contentIllustration;
    try {
      let url = contentIllustrationUrls.get(id);
      if (!url) {
        const protectedResponse = await operatorFetch(`/api/content/works/${encodeURIComponent(id)}/illustration`);
        const blob = await protectedResponse.response.blob();
        assertOperatorSession(protectedResponse);
        url = URL.createObjectURL(blob);
        contentIllustrationUrls.set(id, url);
      }
      const image = document.createElement("img");
      image.src = url;
      image.alt = placeholder.dataset.alt || "文章配图";
      image.loading = "lazy";
      placeholder.replaceWith(image);
    } catch (error) {
      placeholder.classList.add("error");
      placeholder.textContent = `配图读取失败：${error.message}`;
    }
  }));
}

$("content-filter-format").addEventListener("change", renderContentWorks);
$("content-filter-status").addEventListener("change", renderContentWorks);

$("content-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  $("content-create-status").classList.remove("error");
  $("content-create-status").textContent = "Chief 正在登记双人创作任务…";
  try {
    const work = await operatorApi("/api/content/works", { method: "POST", body: JSON.stringify({
      format: $("content-format").value,
      source_candidate_id: $("content-candidate").value || undefined,
      topic: $("content-topic").value.trim() || undefined,
    }) });
    $("content-create-status").textContent = "已召集听风、千工与绘影；研究、写作、审校和配图会在后台继续";
    await watchContentWork(work.id);
  } catch (error) {
    $("content-create-status").classList.add("error");
    $("content-create-status").textContent = error.message;
  } finally { button.disabled = false; }
});

$("content-schedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    const formats = [$("content-schedule-x").checked && "x_hot_post", $("content-schedule-long").checked && "longform_tutorial"].filter(Boolean);
    const value = await operatorApi("/api/content/preferences", { method: "PUT", body: JSON.stringify({
      enabled: $("content-schedule-enabled").checked,
      min_interval_hours: Number($("content-min-hours").value),
      max_interval_hours: Number($("content-max-hours").value), formats,
    }) });
    $("content-schedule-status").textContent = value.enabled
      ? `节律已保存；下一次窗口 ${new Date(value.next_run_at).toLocaleString()}`
      : "自动创作已暂停；手动创作仍可使用";
  } catch (error) { $("content-schedule-status").textContent = error.message; }
  finally { button.disabled = false; }
});

$("content-works").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-content],[data-retry-illustration],[data-download-illustration]");
  if (!button) return;
  const card = button.closest("[data-content-work]");
  const work = contentWorks.find((item) => item.id === card.dataset.contentWork);
  const statusNode = card.querySelector(".copy-status");
  button.disabled = true;
  try {
    if (button.matches("[data-retry-illustration]")) {
      statusNode.textContent = "已重新召集绘影，正在生成并验收…";
      await operatorApi(`/api/content/works/${encodeURIComponent(work.id)}/illustration/retry`, { method: "POST", body: "{}" });
      await watchContentWork(work.id);
      return;
    }
    if (button.matches("[data-download-illustration]")) {
      const protectedResponse = await operatorFetch(`/api/content/works/${encodeURIComponent(work.id)}/illustration`);
      const blob = await protectedResponse.response.blob();
      assertOperatorSession(protectedResponse);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${work.id}-illustration`; link.click();
      URL.revokeObjectURL(url);
      statusNode.textContent = "配图已下载";
      return;
    }
    await copyText(work.body);
    const updated = await operatorApi(`/api/content/works/${encodeURIComponent(work.id)}/copied`, { method: "POST", body: "{}" });
    statusNode.textContent = "正文已复制；这次采纳已记入协作成员经历";
    contentWorks = contentWorks.map((item) => item.id === updated.id ? updated : item);
    await loadMemberDossiers();
  } catch (error) {
    statusNode.classList.add("error"); statusNode.textContent = `复制失败：${error.message}`;
  } finally { button.disabled = false; }
});

async function watchContentWork(id) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const work = await operatorApi(`/api/content/works/${encodeURIComponent(id)}`);
    const index = contentWorks.findIndex((item) => item.id === id);
    if (index >= 0) contentWorks[index] = work; else contentWorks.unshift(work);
    renderContentWorks();
    const illustrationActive = ["pending", "briefing", "generating", "reviewing"].includes(work.illustration?.status);
    if (["ready", "failed"].includes(work.status) && !illustrationActive) {
      $("content-create-status").textContent = work.status === "ready"
        ? work.illustration?.status === "ready" ? "文字与配图均已通过，作品可复制和下载" : "文字已通过；配图未通过，可在作品卡中重试"
        : `创作未通过：${work.error}`;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  $("content-create-status").textContent = "创作仍在后台进行，可稍后刷新查看";
}

async function copyText(value) {
  if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(value);
  const node = document.createElement("textarea");
  node.value = value; node.setAttribute("readonly", ""); node.style.position = "fixed"; node.style.opacity = "0";
  document.body.appendChild(node); node.select();
  const copied = document.execCommand("copy"); node.remove();
  if (!copied) throw new Error("浏览器拒绝剪贴板访问，请手动选择正文复制");
}

async function loadSettlement() {
  settlement = await api("/api/settlement");
  $("workplace").innerHTML = `<option value="">临时路径</option>` + settlement.workplaces.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.path)}</option>`).join("");
  renderMissionOptions();
  toggleWorkspacePath();
}

function renderMissionOptions() {
  const workplaceId = $("workplace").value;
  const missions = settlement.missions.filter((item) => item.status === "active" && (!workplaceId || item.workplace_id === workplaceId));
  $("mission").innerHTML = `<option value="">创建新 Mission</option>` + missions.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)} · ${item.requests.length} 次执行</option>`).join("");
}

function toggleWorkspacePath() {
  $("workspace-label").classList.toggle("hidden", Boolean($("workplace").value));
  renderMissionOptions();
  const workplace = settlement.workplaces.find((item) => item.id === $("workplace").value);
  $("policy-instructions").value = workplace?.policy?.instructions || "";
  $("policy-validations").value = (workplace?.policy?.validation_commands || []).join("\n");
  if (workplace?.policy?.forbidden_paths?.length) $("policy-forbidden").value = workplace.policy.forbidden_paths.join("\n");
  $("policy-target-branch").value = workplace?.policy?.git_flow?.target_branch || "main";
  $("policy-remote-enabled").checked = workplace?.policy?.git_flow?.remote_provider === "github";
  $("policy-merge-enabled").checked = Boolean(workplace?.policy?.git_flow?.allow_merge);
  $("policy-opencode-enabled").checked = Boolean(workplace?.policy?.git_flow?.allow_opencode_fix);
  $("policy-status").textContent = workplace?.policy ? `已安装 Policy v${workplace.policy.version}` : "尚未安装规范";
}
$("workplace").addEventListener("change", () => { toggleWorkspacePath(); void analyzeIntake(); });
$("mission").addEventListener("change", () => void analyzeIntake());
let analyzeTimer;
$("goal").addEventListener("input", () => { clearTimeout(analyzeTimer); analyzeTimer = setTimeout(analyzeIntake, 250); });

async function analyzeIntake() {
  const analysis = await api("/api/intake/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    goal: $("goal").value, workspace: $("workspace").value,
    workplace_id: $("workplace").value, mission_id: $("mission").value,
  }) });
  const node = $("intake-analysis");
  const developmentReady = analysis.type === "change";
  node.className = `intake-analysis ${analysis.execution_enabled || developmentReady ? "ready" : "gated"}`;
  node.textContent = `${analysis.type.toUpperCase()} · ${analysis.reason}${developmentReady ? " · 已开放受控的现有改动提交" : analysis.execution_enabled ? "" : " · 当前仅完成能力骨架，暂不执行"}`;
  return analysis;
}
$("add-workplace").addEventListener("click", async () => {
  try {
    const workplace = await operatorApi("/api/workplaces", { method: "POST", body: JSON.stringify({ name: $("workplace-name").value, path: $("workplace-path").value }) });
    await loadSettlement(); $("workplace").value = workplace.id; toggleWorkspacePath();
  } catch (error) { alert(error.message); }
});

$("save-policy").addEventListener("click", async () => {
  if (!$("workplace").value) return alert("请先选择已登记工作地");
  try {
    const policy = await operatorApi(`/api/workplaces/${$("workplace").value}/policy`, {
      method: "PUT",
      body: JSON.stringify({
        instructions: $("policy-instructions").value,
        validation_commands: lines("policy-validations"),
        allowed_commit_types: ["feat", "fix", "docs", "refactor", "test", "chore"],
        forbidden_paths: lines("policy-forbidden"),
        git_flow: {
          remote_provider: $("policy-remote-enabled").checked ? "github" : "none",
          target_branch: $("policy-target-branch").value.trim() || "main",
          allow_issue: $("policy-remote-enabled").checked,
          allow_push: $("policy-remote-enabled").checked,
          allow_pull_request: $("policy-remote-enabled").checked,
          allow_merge: $("policy-merge-enabled").checked,
          allow_opencode_fix: $("policy-opencode-enabled").checked,
        },
      }),
    });
    $("policy-status").textContent = `已安装 Policy v${policy.version}`;
    await loadSettlement();
  } catch (error) { alert(error.message); }
});

async function loadHistory() {
  const { jobs } = await api("/api/jobs");
  $("history").innerHTML = jobs.length ? jobs.slice(0, 8).map((job) => `<article>
    <p>${escapeHtml(job.goal || "未命名任务")}</p><small>${escapeHtml(job.status)} / ${escapeHtml(job.phase)}${job.failure ? ` / ${escapeHtml(job.failure.category)} / ${job.failure.retryable ? "可重试" : "需处理"}` : ""} · ${new Date(job.created_at).toLocaleString()}${job.error ? ` · ${escapeHtml(explainFailure(job.error))}` : ""}</small>
  </article>`).join("") : "<small>还没有任务记录</small>";
}

async function loadDevelopmentHistory() {
  if (!operatorAuthenticated) {
    clearProtectedDevelopmentUi();
    return;
  }
  try {
    const [{ proposals }, taskData, skillData] = await Promise.all([
      operatorApi("/api/development/proposals", { method: "GET" }),
      operatorApi("/api/development/tasks", { method: "GET" }),
      operatorApi("/api/development/skill-proposals", { method: "GET" }),
    ]);
    const tasks = Array.isArray(taskData) ? taskData : taskData.tasks || [];
    const unresolvedTasks = tasks.filter((task) =>
      ["queued", "running", "failed"].includes(task.status) && !task.proposal_id && !task.result?.id);
    const history = [
      ...unresolvedTasks.map((task) => ({ kind: "task", at: task.updated_at || task.created_at, value: task })),
      ...proposals.map((proposal) => ({ kind: "proposal", at: proposal.updated_at || proposal.created_at, value: proposal })),
    ].sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, 8);
    $("development-history").innerHTML = history.map((entry) => entry.kind === "task"
      ? renderDevelopmentTaskHistory(entry.value)
      : renderDevelopmentProposalHistory(entry.value)).join("") || "<small>还没有开发专业任务</small>";
    document.querySelectorAll(".proposal-open").forEach((button) => button.addEventListener("click", async () => {
      const proposal = await operatorApi(`/api/development/proposals/${button.dataset.id}`, { method: "GET" });
      activeDevelopmentTaskId = undefined;
      activeDevelopmentProposal = proposal.id;
      $("run-panel").classList.remove("hidden");
      renderDevelopmentProposal(proposal);
    }));
    document.querySelectorAll(".evidence-copy").forEach((button) => button.addEventListener("click", async () => {
      await copyText(button.dataset.evidenceId);
      button.textContent = "已复制";
    }));
    document.querySelectorAll("[data-development-task-check]").forEach((button) => button.addEventListener("click", async () => {
      const statusNode = button.closest("article")?.querySelector("[data-development-task-status]");
      await checkDevelopmentTask(button.dataset.developmentTaskCheck, button, statusNode);
    }));
    const pending = skillData.proposals.filter((proposal) => proposal.status === "pending");
    $("skill-proposal-history").innerHTML = pending.map((proposal) => `<article>
      <p>Skill 改进提案：${escapeHtml(proposal.proposed_addition)}</p>
      <small>基于 v${proposal.base_version} · 证据 Commit ${escapeHtml(proposal.evidence.commit_sha)}</small>
      <button type="button" class="secondary skill-approve" data-id="${escapeHtml(proposal.id)}">批准升级 Skill</button>
    </article>`).join("") || "<small>没有待批准的 Skill 改进</small>";
    document.querySelectorAll(".skill-approve").forEach((button) => button.addEventListener("click", async () => {
      const active = await operatorApi(`/api/development/skill-proposals/${button.dataset.id}/approve`, { method: "POST" });
      alert(`Skill 已升级到 v${active.version}`);
      await loadDevelopmentHistory();
    }));
  } catch (error) {
    $("development-history").innerHTML = `<small class="error">${escapeHtml(error.message)}</small>`;
  }
}

function renderDevelopmentProposalHistory(proposal) {
  return `<article>
    <p>${escapeHtml(proposal.commit_message)}</p><small>${escapeHtml(proposal.status)} · ${new Date(proposal.created_at).toLocaleString()} · 证据 ID <code>${escapeHtml(proposal.id)}</code>${proposal.skill?.commission_id ? ` · 试用案卷 <code>${escapeHtml(proposal.skill.commission_id)}</code>` : " · 当前能力基线"}</small>
    <div class="history-actions"><button type="button" class="secondary proposal-open" data-id="${escapeHtml(proposal.id)}">查看</button><button type="button" class="secondary evidence-copy" data-evidence-id="${escapeHtml(proposal.id)}">复制证据 ID</button></div>
  </article>`;
}

function renderDevelopmentTaskHistory(task) {
  const status = task.status === "failed" ? "失败" : task.status === "running" ? "执行中" : "排队中";
  return `<article data-development-task="${escapeHtml(task.id)}">
    <p>${escapeHtml(task.goal || "未命名 Git 专业任务")}</p>
    <small data-development-task-status class="${task.status === "failed" ? "error" : ""}">${status} · 后台任务 ID <code>${escapeHtml(task.id)}</code> · ${new Date(task.updated_at || task.created_at).toLocaleString()}${task.error ? ` · ${escapeHtml(task.error)}` : ""}</small>
    <div class="history-actions"><button type="button" class="secondary" data-development-task-check="${escapeHtml(task.id)}">检查结果</button></div>
  </article>`;
}

function clearProtectedDevelopmentUi() {
  const hadDevelopmentSurface = Boolean(activeDevelopmentProposal || activeDevelopmentTaskId || $("development-proposal").textContent.trim());
  activeDevelopmentProposal = undefined;
  activeDevelopmentTaskId = undefined;
  $("development-history").innerHTML = "<small>输入操作员 Token 后显示开发专业任务。</small>";
  $("skill-proposal-history").innerHTML = "<small>输入操作员 Token 后显示 Skill 改进提案。</small>";
  $("development-proposal").innerHTML = "";
  if (hadDevelopmentSurface) {
    $("phase").textContent = "LOCKED";
    $("run-message").textContent = "开发任务证据已锁定；输入操作员 Token 后可重新查看";
    $("progress-bar").style.width = "0%";
  }
}

$("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $("run-panel").classList.remove("hidden");
  $("staffing").innerHTML = ""; $("report").innerHTML = ""; $("development-proposal").innerHTML = ""; $("trace-wrap").classList.add("hidden");
  try {
    const analysis = await analyzeIntake();
    if (analysis.type === "change") {
      await prepareDevelopmentCommit();
      return;
    }
    if (!analysis.execution_enabled) throw new Error(`任务模式 ${analysis.type} 尚未开放执行：${analysis.reason}`);
    const job = await operatorApi("/api/runs", { method: "POST", body: JSON.stringify({
      goal: $("goal").value, workspace: $("workspace").value, workplace_id: $("workplace").value,
      mission_id: $("mission").value, chief: $("chief").value,
      acceptance: $("acceptance").value.split("\n").map((v) => v.trim()).filter(Boolean),
      max_members: numberValue("max-members"), max_total_tokens: numberValue("max-total-tokens"), max_files: numberValue("max-files"), max_context_bytes: numberValue("max-context"), max_output_tokens: numberValue("max-output"),
    }) });
    activeJobId = job.id; $("cancel-run").classList.remove("hidden");
    await watchRun(job.id);
  } catch (error) {
    renderError(error.message);
  } finally { button.disabled = false; }
});

async function prepareDevelopmentCommit() {
  if (!$("workplace").value) throw new Error("开发提交必须选择已登记工作地");
  $("phase").textContent = "PLANNING";
  $("run-message").textContent = "Chief 正在把目标路由给 Git 流程专员，并验收其计划";
  $("progress-bar").style.width = "45%";
  const task = await operatorApi("/api/development/tasks", {
    method: "POST",
    body: JSON.stringify({
      workplace_id: $("workplace").value, goal: $("goal").value,
      mode: $("git-flow-mode").value,
      issue_mode: $("git-flow-mode").value === "commit" ? "none" : "auto",
      trial_commission_id: $("trial-commission-id").value.trim() || undefined,
    }),
  });
  activeDevelopmentTaskId = task.id;
  const proposal = await waitForDevelopmentTask(task.id);
  if (!proposal) {
    renderDeferredDevelopmentTask(task.id);
    await loadDevelopmentHistory();
    return;
  }
  activeDevelopmentTaskId = undefined;
  activeDevelopmentProposal = proposal.id;
  renderDevelopmentProposal(proposal);
  await loadDevelopmentHistory();
}

async function waitForDevelopmentTask(taskId) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const task = await operatorApi(`/api/development/tasks/${encodeURIComponent(taskId)}`);
    $("run-message").textContent = task.status === "running"
      ? "Git 专员正在检查工作树，Chief 将独立验收"
      : `专业任务 ${task.status}`;
    if (task.status === "completed" && task.result) return task.result;
    if (task.status === "failed") {
      activeDevelopmentTaskId = undefined;
      await loadDevelopmentHistory();
      throw new Error(task.error || "Git 专业任务失败");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

function renderDeferredDevelopmentTask(taskId) {
  $("phase").textContent = "RUNNING";
  $("run-message").textContent = "Git 专业任务仍在后台运行，可随时检查，不会因页面停止等待而丢失";
  $("development-proposal").innerHTML = `<article class="proposal" data-deferred-development-task="${escapeHtml(taskId)}">
    <h3>Git 专业任务已转入后台</h3>
    <p>前台等待已到 90 秒上限；任务仍由部落继续执行。</p>
    <div class="proposal-evidence"><span>后台任务 ID</span><code>${escapeHtml(taskId)}</code><button type="button" class="secondary" data-copy-development-task>复制</button></div>
    <button type="button" data-development-task-check="${escapeHtml(taskId)}">检查结果</button>
    <small data-development-task-status class="form-status" role="status" aria-live="polite">尚未再次检查</small>
  </article>`;
  const card = $("development-proposal").querySelector("[data-deferred-development-task]");
  card.querySelector("[data-copy-development-task]").addEventListener("click", async (event) => {
    await copyText(taskId);
    event.currentTarget.textContent = "已复制";
  });
  const button = card.querySelector("[data-development-task-check]");
  button.addEventListener("click", () => void checkDevelopmentTask(taskId, button, card.querySelector("[data-development-task-status]")));
}

async function checkDevelopmentTask(taskId, button, statusNode) {
  button.disabled = true;
  if (statusNode) {
    statusNode.classList.remove("error");
    statusNode.textContent = "正在检查后台任务…";
  }
  try {
    const task = await operatorApi(`/api/development/tasks/${encodeURIComponent(taskId)}`);
    if (task.status === "completed" && task.result) {
      activeDevelopmentTaskId = undefined;
      activeDevelopmentProposal = task.result.id;
      $("run-panel").classList.remove("hidden");
      renderDevelopmentProposal(task.result);
      await loadDevelopmentHistory();
      return;
    }
    if (task.status === "failed") {
      if (statusNode) {
        statusNode.classList.add("error");
        statusNode.textContent = `后台任务失败：${task.error || "未知错误"}`;
      }
      await loadDevelopmentHistory();
      return;
    }
    if (statusNode) statusNode.textContent = `后台任务仍在${task.status === "queued" ? "排队" : "执行"}，稍后可再次检查`;
  } catch (error) {
    if (statusNode) {
      statusNode.classList.add("error");
      statusNode.textContent = `检查失败：${error.message}`;
    }
  } finally {
    button.disabled = false;
  }
}

function renderDevelopmentProposal(proposal) {
  $("phase").textContent = proposal.status.toUpperCase();
  $("progress-bar").style.width = proposal.status === "completed" ? "100%" : "70%";
  $("development-proposal").innerHTML = `<article class="proposal">
    <h3>Git Flow 工作流</h3>
    <p>${escapeHtml(proposal.summary)}</p>
    <p><b>${escapeHtml(proposal.commit_message)}</b></p>
    <div class="chips">Chief / ${escapeHtml(proposal.chief_member_id)} → Git流程专员 / ${escapeHtml(proposal.specialist_member_id)} → Chief 验收</div>
    <div class="proposal-evidence"><span>试炼证据 ID</span><code>${escapeHtml(proposal.id)}</code><button type="button" class="secondary" data-copy-proposal-evidence>复制</button></div>
    <p class="chips">Skill v${proposal.skill.version} · ${proposal.skill.commission_id ? `隔离试用案卷 <code>${escapeHtml(proposal.skill.commission_id)}</code>` : "当前活动能力基线"} · 加载 digest <code>${escapeHtml(proposal.skill.digest || "未记录")}</code>${proposal.skill.package_digest ? ` · 包 digest <code>${escapeHtml(proposal.skill.package_digest)}</code>` : ""}</p>
    <p class="chips">本次评测：${escapeHtml(proposal.evaluation?.usage_status || "unknown")} · ${proposal.evaluation?.total_tokens ?? 0} Tokens · ${proposal.evaluation?.latency_ms ?? 0} ms</p>
    <p>派工理由：${escapeHtml(proposal.assignment_reason)}</p>
    <p>风险：${escapeHtml(proposal.risk)}</p>
    <p>文件：</p><ul>${proposal.files.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>
    <p>批准后验证：</p><ul>${proposal.validation_commands.map((command) => `<li>${escapeHtml(command)}</li>`).join("") || "<li>无验证命令</li>"}</ul>
    <p class="${proposal.self_check.outcome === "accepted" ? "approved" : "error"}">专员自检：${escapeHtml(proposal.self_check.outcome)} · ${escapeHtml(proposal.self_check.rationale)}</p>
    <p class="${proposal.chief_acceptance.outcome === "accepted" ? "approved" : "error"}">Chief 验收：${escapeHtml(proposal.chief_acceptance.outcome)} · ${escapeHtml(proposal.chief_acceptance.rationale)}</p>
    ${proposal.status === "awaiting_approval" ? '<button class="advance-development" data-gate="local" type="button">批准验证并提交</button>' : ""}
    ${proposal.status === "awaiting_remote_approval" ? '<button class="advance-development" data-gate="remote" type="button">批准创建 Issue、Push 和 PR</button>' : ""}
    ${proposal.status === "awaiting_merge_approval" ? '<button class="advance-development" data-gate="merge" type="button">批准 Merge</button>' : ""}
    ${proposal.validation_results ? `<pre>${escapeHtml(JSON.stringify(proposal.validation_results, null, 2))}</pre>` : ""}
    ${proposal.commit_sha ? `<p class="approved">Commit: ${escapeHtml(proposal.commit_sha)}</p>` : ""}
    ${proposal.issue_url ? `<p>Issue: <a href="${escapeHtml(proposal.issue_url)}" target="_blank">${escapeHtml(proposal.issue_url)}</a></p>` : ""}
    ${proposal.pr_url ? `<p>PR: <a href="${escapeHtml(proposal.pr_url)}" target="_blank">${escapeHtml(proposal.pr_url)}</a></p>` : ""}
    ${proposal.error ? `<p class="error">${escapeHtml(proposal.error)}</p>` : ""}
  </article>`;
  document.querySelectorAll(".advance-development").forEach((button) => button.addEventListener("click", () => advanceDevelopment(button.dataset.gate)));
  document.querySelector("[data-copy-proposal-evidence]")?.addEventListener("click", async (event) => {
    await copyText(proposal.id);
    event.currentTarget.textContent = "已复制";
  });
}

async function advanceDevelopment(gate) {
  if (!activeDevelopmentProposal) return;
  $("phase").textContent = "EXECUTING";
  $("run-message").textContent = `正在推进 ${gate} 门禁`;
  const proposal = await operatorApi(`/api/development/proposals/${activeDevelopmentProposal}/advance`, {
    method: "POST", body: JSON.stringify({ gate }),
  });
  renderDevelopmentProposal(proposal);
  await loadDevelopmentHistory();
  await loadSettlement();
}

async function watchRun(id) {
  for (;;) {
    const job = await api(`/api/runs/${id}`);
    $("phase").textContent = job.phase.toUpperCase();
    $("run-message").textContent = job.message;
    $("progress-bar").style.width = `${phases[job.phase] ?? 12}%`;
    renderActivity(job);
    if (job.run?.plan) renderStaffing(job.run);
    if (job.status === "completed") { finishWatching(); renderReport(job.run); await loadHistory(); await loadSettlement(); return; }
    if (job.status === "failed") { finishWatching(); renderError(explainFailure(job.error)); if (job.failure?.retryable) { activeJobId = job.id; $("retry-run").classList.remove("hidden"); } await loadHistory(); await loadSettlement(); return; }
    if (job.status === "cancelled") { finishWatching(); renderError("Run 已取消"); await loadHistory(); await loadSettlement(); return; }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

$("cancel-run").addEventListener("click", async () => {
  if (!activeJobId) return;
  $("cancel-run").disabled = true;
  try { await operatorApi(`/api/runs/${activeJobId}/cancel`, { method: "POST" }); }
  catch (error) { renderError(error.message); }
});

$("retry-run").addEventListener("click", async () => {
  if (!activeJobId) return;
  $("retry-run").disabled = true;
  try {
    const job = await operatorApi(`/api/runs/${activeJobId}/retry`, { method: "POST" });
    $("retry-run").classList.add("hidden"); activeJobId = job.id;
    $("cancel-run").classList.remove("hidden"); await watchRun(job.id);
  } catch (error) { renderError(error.message); }
  finally { $("retry-run").disabled = false; }
});

function finishWatching() { activeJobId = undefined; $("cancel-run").classList.add("hidden"); $("cancel-run").disabled = false; $("retry-run").classList.add("hidden"); }

function renderActivity(job) {
  const started = new Date(job.created_at).getTime();
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  $("activity").innerHTML = `<div><time>${elapsed}s</time>本次 Run 已持续；模型调用期间可能数十秒无新事件</div>` +
    (job.activities || []).map((item) => `<div><time>+${Math.round((new Date(item.at).getTime() - started) / 1000)}s</time>${escapeHtml(item.phase)} · ${escapeHtml(item.message)}</div>`).join("");
}

function renderStaffing(run) {
  $("staffing").innerHTML = `<h3>首领派工</h3>${run.plan.assignments.map((item) => `
    <article class="assignment"><b>${escapeHtml(item.member_id)}</b> · ${escapeHtml(item.role)}
      <div>${escapeHtml(item.instruction)}</div><small>为何选择：${escapeHtml(item.assignment_reason)}</small>
      <div class="chips">依据 / ${item.selection_factors.map(escapeHtml).join(" · ")}　Skills / ${item.skills.map(escapeHtml).join(" · ") || "无"}</div>
      <div class="chips">能力匹配分 / ${item.selection_score ?? "待评估"}　成本效率先验 / ${item.cost_efficiency ?? "待评估"}</div>
    </article>`).join("")}
    <details><summary>查看全部候选排序</summary>${(run.plan.candidate_ranking || []).map((item, index) => `<div class="profile-row"><span>${index + 1}. ${escapeHtml(item.member_id)}${item.selected ? " ✓" : ""}</span><i><b style="width:${Math.round(item.score * 100)}%"></b></i><em>${item.score}</em></div><div class="chips">能力 ${item.capability_match} · 历史 ${item.historical_acceptance ?? "无样本"} · 成本 ${item.cost_efficiency}</div>`).join("")}</details>`;
}

function renderReport(run) {
  const report = run.final_report;
  $("report").innerHTML = `<h3>${escapeHtml(report.title)}</h3><p>${escapeHtml(report.summary)}</p>
    <div class="metrics"><span>${run.review_outcome}</span><span>${run.usage?.calls ?? 0} 次调用</span><span>${run.usage?.total_tokens ?? 0} Tokens</span></div>
    ${report.findings.map((f) => `<article class="finding"><b>${escapeHtml(f.claim)}</b><div class="chips">${f.evidence.map(escapeHtml).join("<br>")}</div></article>`).join("")}
    <h3>建议</h3>${report.recommendations.map((r) => `<p><b>[${escapeHtml(r.priority)}] ${escapeHtml(r.action)}</b><br><small>${escapeHtml(r.reason)}</small></p>`).join("")}
    <h3>验收</h3>${report.acceptance_review.map((r) => `<p><b>${escapeHtml(r.status)}</b> · ${escapeHtml(r.criterion)}<br><small>${escapeHtml(r.evidence)}</small></p>`).join("")}`;
  if (run.independent_review) {
    $("report").innerHTML += `<h3>独立 Reviewer</h3><article class="finding"><b>${escapeHtml(run.independent_review.reviewer_member_id)} · ${escapeHtml(run.independent_review.outcome)}</b><p>${escapeHtml(run.independent_review.rationale)}</p><div class="chips">${run.independent_review.issues.map(escapeHtml).join(" · ") || "未发现额外问题"}</div></article>`;
  }
  $("trace").textContent = JSON.stringify(run, null, 2);
  $("trace-wrap").classList.remove("hidden");
}

function renderError(message) { $("phase").textContent = "FAILED"; $("run-message").innerHTML = `<span class="error">${escapeHtml(message || "未知错误")}</span>`; }
function explainFailure(message = "") { return message.includes("stop_reason=max_tokens") || message.includes("returned no text content") ? `${message}。模型输出预算可能耗尽；DeepSeek 建议至少 6000 Token 后重试。` : message; }
function numberValue(id) { const value = Number($(id).value); return Number.isFinite(value) ? value : undefined; }
function lines(id) { return $(id).value.split("\n").map((value) => value.trim()).filter(Boolean); }
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function operatorApi(url, options = {}) {
  const token = $("operator-token").value.trim();
  const revision = operatorSessionRevision;
  if (!token) throw new Error("请输入操作员 Token");
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}`, ...(options.headers || {}) };
  try {
    const result = await api(url, { ...options, headers });
    if (!operatorAuthenticated || revision !== operatorSessionRevision) throw new Error("操作员登录状态已变化，请重试");
    return result;
  } catch (error) {
    if (error.status === 401) invalidateOperatorSession("Token 已失效，请重新登录。");
    throw error;
  }
}
async function operatorFetch(url, options = {}) {
  const token = $("operator-token").value.trim();
  const revision = operatorSessionRevision;
  if (!token) throw new Error("请输入操作员 Token");
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch {}
    if (response.status === 401) invalidateOperatorSession("Token 已失效，请重新登录。");
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  const protectedResponse = { response, revision, token };
  assertOperatorSession(protectedResponse);
  return protectedResponse;
}
function assertOperatorSession(protectedResponse) {
  if (!operatorAuthenticated || protectedResponse.revision !== operatorSessionRevision || protectedResponse.token !== $("operator-token").value.trim()) {
    throw new Error("操作员登录状态已变化，请重试");
  }
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", "\"":"&quot;" })[char]); }
function externalLink(value, label) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return escapeHtml(label);
    return `<a href="${escapeHtml(url.toString())}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  } catch { return escapeHtml(label); }
}

async function loadSkillsRoute() {
  const registry = loadSkillRegistry();
  try {
    [tribe, status, settlement] = await Promise.all([api("/api/tribe"), api("/api/status"), api("/api/settlement")]);
    $("tribe-status").textContent = `${status.version} · ${tribe.tribe.name} · ${status.active_members} 名可用成员`;
    if (activeRegistrySkillId) renderSkillRegistryDetail(registrySkills.find((skill) => skill.id === activeRegistrySkillId));
  } catch {
    $("tribe-status").textContent = "Skills 控制面 · 部落状态暂不可用";
    $("tribe-status").classList.add("error");
  }
  await Promise.allSettled([registry, loadSkillCommissions()]);
}

if (skillsRoute) {
  void loadSkillsRoute();
} else {
  loadTribe().then(analyzeIntake).catch((error) => { $("tribe-status").textContent = error.message; $("tribe-status").classList.add("error"); });
  window.setInterval(() => { if (!document.hidden) void loadObservatory({ quiet: true }); }, 30_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadObservatory({ quiet: true }); });
}
