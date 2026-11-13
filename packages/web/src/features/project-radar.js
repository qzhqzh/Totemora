import { $, escapeHtml, externalLink, formatObservatoryTime } from "../shared/dom.js";
import { operatorApi, operatorSession, openOperatorDialog } from "../shared/operator-session.js";
import { projectRadarActionsFeature } from "./project-radar-actions.js";

const endpoint = "/api/intelligence/radar";
const modes = { off: "关闭", shadow: "观察", active: "每日精选" };
const routes = { immediate: "优先关注", digest: "收录精选", hold: "留存", review: "待核实" };
const digestStatuses = { preview: "精选预览", sending: "正在投递", completed: "已投递", failed: "投递失败", uncertain: "投递结果待核实", empty: "暂无符合条件的消息" };
const feedbackLabels = { valuable: "有价值", not_valuable: "没价值", duplicate: "重复", too_late: "太晚" };
let state = null;
let digest = null;
let actions = [];
let busy = false;
let dirty = false;
let generation = 0;
let boundPanel = null;
const disabledControls = new Map();

export const projectRadarFeature = {
  load,
  refreshProtected: load,
  lockProtected() {
    generation += 1;
    state = null;
    digest = null;
    actions = [];
    projectRadarActionsFeature.lockProtected();
    busy = false;
    dirty = false;
    disabledControls.clear();
    renderLocked();
  },
};

async function load() {
  const panel = $("project-radar-panel");
  if (!panel) return;
  bind(panel);
  if (!operatorSession.authenticated) return projectRadarFeature.lockProtected();
  if (busy || dirty) return;
  const request = ++generation;
  if (!state) panel.innerHTML = `${heading()}<p class="section-note" role="status">正在读取项目雷达…</p>`;
  try {
    const results = await Promise.all([operatorApi(endpoint), operatorApi(`${endpoint}/digest`)]);
    if (request !== generation || !operatorSession.authenticated || dirty || busy) return;
    const actionResponse = results[0].baseline_available === true ? await operatorApi(`${endpoint}/actions`) : { actions: [] };
    if (request !== generation || !operatorSession.authenticated || dirty || busy) return;
    [state, digest] = results;
    actions = actionResponse.actions || [];
    render();
    return true;
  } catch (error) {
    if (request !== generation || !operatorSession.authenticated) return;
    if (!state) panel.innerHTML = `${heading()}<p id="project-radar-status" class="error" role="status"></p><button type="button" data-radar-action="refresh" class="secondary">重新读取</button>`;
    status(`读取失败：${error.message}`, true);
    return false;
  }
}

function bind(panel) {
  if (boundPanel === panel) return;
  boundPanel = panel;
  panel.addEventListener("click", handleClick);
  panel.addEventListener("submit", saveSettings);
  panel.addEventListener("input", (event) => {
    if (!event.target.closest("#project-radar-settings")) return;
    dirty = true;
    status("有尚未保存的调整。");
  });
}

function heading() {
  return '<div class="section-title"><h2 id="project-radar-heading">项目情报雷达</h2><span>PROJECTS / ACTIONS</span></div>';
}

function renderLocked() {
  const panel = $("project-radar-panel");
  if (!panel) return;
  bind(panel);
  panel.innerHTML = `${heading()}<p class="section-note">登录操作员账户后，可编辑项目关注点、查看精选和评估对照。</p><button type="button" data-radar-action="login" class="secondary">操作员登录</button>`;
}

function render() {
  const settings = state.settings;
  const configured = state.configured === true;
  const rules = state.evaluation_method === "rules" || (!configured && state.baseline_available === true);
  const available = configured || state.baseline_available === true;
  const projects = settings.projects || [];
  $("project-radar-panel").innerHTML = `${heading()}
    <p class="section-note">围绕你正在推进的项目筛选新变化。观察模式每小时评估、记录建议；每日精选模式会在设定时间投递符合条件的消息。</p>
    <div class="channel-status ${available ? "ready" : "degraded"}">${rules ? "规则基线可用 · 无需配置 Jev · 不消耗模型 Token" : configured ? `Jev 已配置 · ${escapeHtml(state.model || "Jev")}` : "评估暂不可用，请检查服务配置。"} · 当前模式：${escapeHtml(modes[settings.mode] || settings.mode)}</div>
    <form id="project-radar-settings" class="intelligence-preferences">
      <div class="grid-two"><label>运行模式<select name="mode">${Object.entries(modes).map(([value, label]) => `<option value="${value}" ${settings.mode === value ? "selected" : ""} ${value !== "off" && !available ? "disabled" : ""}>${label}</option>`).join("")}</select></label><label>精选时间（北京时间）<input name="digest_time" type="time" required value="${escapeHtml(settings.digest_time || "19:30")}"></label></div>
      <div class="grid-two">${projects.map(renderProject).join("")}</div>
      <div class="grid-three">${numberInput("digest_limit", "精选条数上限", settings.digest_limit ?? 5, 1, 5)}${numberInput("daily_evaluation_limit", "每日评估条数预算", settings.daily_evaluation_limit ?? 100, 1, 500)}${numberInput("daily_token_limit", "每日模型 Token 预算（仅 Jev）", settings.daily_token_limit ?? 50000, 1000, 250000)}</div>
      <button type="submit" class="secondary">保存项目雷达设置</button>
    </form>
    <div class="finance-actions"><button type="button" data-radar-action="evaluate" ${canEvaluate() ? "" : "disabled"}>评估最近 10 条候选</button><button type="button" data-radar-action="refresh" class="secondary">刷新结果</button></div>
    <p id="project-radar-status" class="domain-status" role="status" aria-live="polite">${canEvaluate() ? rules ? "手动评估使用规则匹配，不消耗模型 Token。" : "手动评估会使用模型预算。" : "保存为观察或每日精选模式后，可手动评估。"}打开消息只表示阅读，不等同于认可。</p>
    <p class="chips">${renderUsage(state.usage)}</p>
    <h3>今日精选</h3><p class="section-note">${escapeHtml(digest?.date || "")} · ${escapeHtml(digestStatuses[digest?.status] || digest?.status || "尚未生成")} · 最多 ${escapeHtml(settings.digest_limit)} 条</p>
    <div class="intelligence-history">${renderItems(digest?.items || [], "暂无精选；完成候选评估后可查看符合条件的消息。")}</div>
    ${state.baseline_available === true ? projectRadarActionsFeature.render(actions) : '<p class="section-note">当前服务尚不支持行动建议。</p>'}
    <details class="source-ledger"><summary>原有评分与评估建议对照</summary><p class="domain-status">规则匹配不提供模型信心。Jev 判断信心反映模型选择的集中程度；来源可信度仍需查看证据。</p><div class="intelligence-history">${renderItems(state.evaluations || [], "暂无评估记录。", true)}</div></details>`;
}

function renderProject(project, index) {
  return `<fieldset class="brief" data-radar-project="${escapeHtml(project.id)}"><legend>${escapeHtml(project.name)}</legend>
    <label class="inline-check"><input name="project_${index}_enabled" type="checkbox" ${project.enabled ? "checked" : ""}>纳入项目匹配</label>
    <label>项目名称<input name="project_${index}_name" required maxlength="100" value="${escapeHtml(project.name)}"></label>
    <label>当前目标<textarea name="project_${index}_goal" required maxlength="1000">${escapeHtml(project.goal)}</textarea></label>
    <label>关注关键词（每行一项）<textarea name="project_${index}_focus" required maxlength="4020">${escapeHtml((project.focus || []).join("\n"))}</textarea><small>填写原文可能出现的词，例如 MCP、agent、检索；规则按完整词句匹配，不会自动翻译。最多 20 项，每项不超过 200 字。</small></label>
    <label>排除项（每行一项）<textarea name="project_${index}_exclude" maxlength="4020">${escapeHtml((project.exclude || []).join("\n"))}</textarea></label></fieldset>`;
}

function numberInput(name, label, value, min, max) {
  return `<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" step="1" required value="${escapeHtml(value)}"></label>`;
}

function renderUsage(usage = {}) {
  return `今日规则评估 ${escapeHtml(usage.rules_evaluations ?? 0)} 条 · 模型评估 ${escapeHtml(usage.evaluations ?? 0)} 条 · 输入 Token ${escapeHtml(usage.input_tokens ?? 0)} · 模型失败 ${escapeHtml(usage.failures ?? 0)} · 进行中 ${escapeHtml(usage.pending ?? 0)}`;
}

function percent(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function renderItems(items, emptyText, comparison = false) {
  return items.slice(0, 20).map((item) => {
    const rules = item.evaluation_method === "rules";
    const projectScores = (item.projects || []).map((match) => {
      const project = state.settings.projects.find((entry) => entry.id === match.project_id);
      return `${project?.name || match.project_id} 相关性 ${percent(match.relevance)}`;
    });
    return `<article class="brief" data-radar-candidate="${escapeHtml(item.candidate_id)}"><h4>${externalLink(item.url, item.headline || "候选消息")}</h4>
      <p>${escapeHtml(item.brief || "")}</p>${comparison ? `<div class="chips">原有评分 ${percent(item.baseline?.scores?.total)} · ${rules ? "规则匹配" : "Jev 建议"}：${escapeHtml(routes[item.route] || item.route || "待评估")} · ${rules ? "不提供模型信心" : `判断信心 ${percent(item.decision_confidence)}`}</div>` : ""}
      <p class="domain-status">${escapeHtml((comparison ? projectScores : item.project_names || []).join(" · "))}</p><p>${escapeHtml(item.reason || "")}</p>${item.created_at ? `<small>${escapeHtml(formatObservatoryTime(item.created_at))}</small>` : ""}
      <div class="candidate-feedback" role="group" aria-label="评价这条项目消息">${Object.entries(feedbackLabels).map(([signal, label]) => `<button type="button" data-radar-feedback="${signal}">${label}</button>`).join("")}</div><small class="feedback-status" aria-live="polite">主动评价帮助判断后续消息是否有用。</small></article>`;
  }).join("") || `<p class="section-note">${escapeHtml(emptyText)}</p>`;
}

function status(message, isError = false) {
  const node = $("project-radar-status");
  if (!node) return;
  node.classList.toggle("error", isError);
  node.textContent = message;
}

function setBusy(value) {
  busy = value;
  if (value) generation += 1;
  if (value) {
    $("project-radar-panel")?.querySelectorAll("button, input, textarea, select").forEach((node) => {
      disabledControls.set(node, node.disabled);
      node.disabled = true;
    });
  } else {
    for (const [node, disabled] of disabledControls) node.disabled = disabled;
    disabledControls.clear();
  }
}

function canEvaluate() {
  return (state?.configured === true || state?.baseline_available === true) && state?.settings?.mode !== "off";
}

async function saveSettings(event) {
  if (event.target.id !== "project-radar-settings") return;
  event.preventDefault();
  if (busy || !state) return;
  const form = new FormData(event.target);
  const lines = (name) => String(form.get(name) || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const settings = {
    version: 1, mode: form.get("mode"), timezone: "Asia/Shanghai",
    digest_time: form.get("digest_time"), digest_limit: Number(form.get("digest_limit")),
    daily_evaluation_limit: Number(form.get("daily_evaluation_limit")), daily_token_limit: Number(form.get("daily_token_limit")),
    projects: state.settings.projects.map((project, index) => ({
      id: project.id, name: String(form.get(`project_${index}_name`) || "").trim(),
      goal: String(form.get(`project_${index}_goal`) || "").trim(),
      focus: lines(`project_${index}_focus`), exclude: lines(`project_${index}_exclude`),
      enabled: form.has(`project_${index}_enabled`),
    })),
  };
  if (settings.mode !== "off" && !state.configured && !state.baseline_available) return status("评估暂不可用，请检查服务配置。", true);
  await mutate(async () => {
    await operatorApi(`${endpoint}/settings`, { method: "PUT", body: JSON.stringify(settings) });
    dirty = false;
    return "项目雷达设置已保存。";
  });
}

async function handleClick(event) {
  const button = event.target.closest("[data-radar-action], [data-radar-feedback], [data-radar-decision], [data-radar-handoff], [data-radar-copy]");
  if (!button || busy) return;
  const action = button.dataset.radarAction;
  if (action === "login") return openOperatorDialog();
  if (button.dataset.radarFeedback) return sendFeedback(button);
  if (dirty) return status("请先保存当前调整，再处理结果。");
  if (button.matches("[data-radar-decision], [data-radar-handoff], [data-radar-copy]")) {
    return projectRadarActionsFeature.handleClick(button, { mutate, status });
  }
  if (action === "refresh") return load();
  if (action !== "evaluate" || !canEvaluate()) return;
  await mutate(async () => {
    const result = await operatorApi(`${endpoint}/evaluate`, { method: "POST", body: JSON.stringify({ limit: 10 }) });
    return `评估完成：新增 ${result.evaluated ?? result.evaluations?.length ?? 0} 条，复用 ${result.cached ?? 0} 条，失败 ${result.failed ?? 0} 条，跳过 ${result.skipped ?? 0} 条。${result.budget_exhausted ? "今日预算已用完。" : ""}`;
  });
}

async function mutate(operation) {
  const revision = operatorSession.revision;
  setBusy(true);
  status("正在处理，请稍候…");
  try {
    const message = await operation();
    if (revision !== operatorSession.revision) return;
    setBusy(false);
    const refreshed = await load();
    if (revision !== operatorSession.revision) return;
    if (refreshed) status(message);
    else status(`${message} ${$("project-radar-status")?.textContent || "结果尚未刷新，请稍后重试。"}`, true);
  } catch (error) {
    if (revision === operatorSession.revision) status(`操作失败：${error.message}`, true);
  } finally {
    if (revision === operatorSession.revision) setBusy(false);
  }
}

async function sendFeedback(button) {
  const revision = operatorSession.revision;
  const card = button.closest("[data-radar-candidate]");
  const node = card.querySelector(".feedback-status");
  const buttons = card.querySelectorAll("[data-radar-feedback]");
  buttons.forEach((item) => { item.disabled = true; });
  node.classList.remove("error");
  node.textContent = "正在记录反馈…";
  try {
    const result = await operatorApi(`/api/intelligence/candidates/${encodeURIComponent(card.dataset.radarCandidate)}/feedback`, {
      method: "POST", body: JSON.stringify({ signal: button.dataset.radarFeedback }),
    });
    if (revision !== operatorSession.revision || !card.isConnected) return;
    node.textContent = result.inserted ? "反馈已记录。打开次数不会替代这条明确评价。" : "该反馈已记录，没有重复计权。";
  } catch (error) {
    if (revision !== operatorSession.revision || !card.isConnected) return;
    node.classList.add("error");
    node.textContent = `反馈失败：${error.message}`;
  } finally {
    if (revision === operatorSession.revision && card.isConnected) buttons.forEach((item) => { item.disabled = false; });
  }
}
