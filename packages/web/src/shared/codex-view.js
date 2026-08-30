import { escapeHtml } from "./dom.js";

const PHASE_LABELS = {
  observed: "观察中", aligning: "对齐中", executing: "执行中", waiting_decision: "等待决策",
  waiting_approval: "等待审批", retry_wait: "等待重试", verifying: "验证中", paused: "已暂停",
  completed: "已完成", failed: "失败",
};

const KIND_LABELS = { fyi: "进展", suggest: "建议", decision: "需要决策", approval: "系统审批" };
const ATTENTION_PHASES = new Set(["waiting_decision", "waiting_approval", "paused", "failed"]);

export function renderConnection(status) {
  if (!status) return {
    className: "", label: "等待操作员登录", running: "Codex 正在运行 —",
    managed: "Totemora 托管中 —", socket: "Socket —", scan: "最后同步 —",
  };
  const label = !status.enabled ? "Supervisor 未启用" : status.connected ? "共享 App Server 已连接" : "App Server 未连接";
  return {
    className: status.connected ? "connected" : status.last_error ? "error" : "",
    label,
    running: `Codex 正在运行 ${status.running_threads ?? 0}`,
    managed: `Totemora 托管中 ${status.managed_threads}`,
    socket: `Socket ${status.socket_path || "—"}`,
    scan: `最后同步 ${formatClock(status.last_scan_at)}`,
  };
}

export function filterThreads(threads, mode, query) {
  const normalized = query.trim().toLowerCase();
  return threads.filter((thread) => {
    if (mode === "running" && thread.app_status !== "active") return false;
    if (mode === "managed" && thread.mode !== "managed") return false;
    if (mode === "attention" && !ATTENTION_PHASES.has(thread.phase)) return false;
    if (!normalized) return true;
    return [thread.title, thread.preview, thread.goal_objective, thread.cwd, thread.workplace_id, thread.thread_id]
      .filter(Boolean).join(" ").toLowerCase().includes(normalized);
  });
}

export function renderTaskList(threads, selectedThreadId) {
  if (!threads.length) return '<p class="codex-empty">没有符合当前筛选条件的任务。</p>';
  return threads.map((thread) => {
    const title = taskTitle(thread);
    const stateClass = ATTENTION_PHASES.has(thread.phase) ? "attention"
      : thread.mode === "managed" ? "managed" : thread.app_status === "active" ? "running" : "";
    return `<button type="button" class="codex-task-row" data-thread-id="${escapeHtml(thread.thread_id)}" aria-pressed="${thread.thread_id === selectedThreadId}">
      <span class="codex-task-row-head"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(formatClock(thread.app_updated_at))}</span></span>
      <p>${escapeHtml(thread.goal_objective || thread.preview || "暂无 Goal 摘要")}</p>
      <span class="codex-task-row-foot"><span>${escapeHtml(workplaceLabel(thread))}</span><span class="codex-task-state ${stateClass}">${escapeHtml(taskStateLabel(thread))}</span></span>
    </button>`;
  }).join("");
}

export function renderDetail(payload) {
  if (!payload) return `<div class="codex-placeholder"><span>CODEX</span><h2 id="codex-detail-title">选择一个任务</h2><p>观察所有正在运行的 Codex 任务；只有显式托管的任务才会被续跑。</p></div>`;
  const { thread, directives = [], interactions = [] } = payload;
  const events = timelineEvents(directives, interactions);
  return `<div class="codex-detail-header">
    <div class="codex-detail-title-row"><div><span class="codex-phase-label"><i class="codex-status-dot ${ATTENTION_PHASES.has(thread.phase) ? "attention" : thread.app_status === "active" || thread.mode === "managed" ? "active" : ""}"></i>${escapeHtml(taskStateLabel(thread))}</span><h2 id="codex-detail-title">${escapeHtml(taskTitle(thread))}</h2></div><div class="codex-detail-id">任务 ID<br>${escapeHtml(thread.thread_id)}</div></div>
    <div class="codex-goal"><small>Goal</small><strong>${escapeHtml(thread.goal_objective || "尚未托管；Totemora 只观察，不会续跑这个任务。")}</strong></div>
    ${thread.last_error ? `<div class="codex-notice codex-error">任务错误：${escapeHtml(thread.last_error)}</div>` : ""}
    ${historyModeNotice(thread)}
  </div>
  ${phaseTrack(thread.phase)}
  <dl class="codex-ledger">
    ${ledger("预算", thread.token_budget ? `${number(thread.token_used)} / ${number(thread.token_budget)} tokens` : "未设置")}
    ${ledger("截止时间", thread.deadline_at ? formatDate(thread.deadline_at) : "未设置")}
    ${ledger("工作地", `${thread.workplace_id || "未登记"}\n${thread.cwd}`)}
    ${ledger("当前 Turn", thread.current_turn_id ? `${thread.current_turn_id}\n${thread.last_turn_status || "进行中"}` : "无活动 Turn")}
    ${ledger("历史模式", historyModeLabel(thread.history_mode))}
    ${ledger("基础设施重试", thread.infra_retries ? `${number(thread.infra_retries)} 次${thread.next_action_at ? `\n下次 ${formatClock(thread.next_action_at)}` : ""}` : "无")}
  </dl>
  <section class="codex-history"><h3>最近指令 / 检查点</h3>${events.length ? events.map(renderEvent).join("") : '<p class="codex-empty">尚无监督记录。</p>'}</section>
  ${actionBar(thread)}`;
}

export function renderInteractions(interactions) {
  const visible = interactions.filter((item) => ["open", "manual_attention"].includes(item.status));
  if (!visible.length) return '<p class="codex-empty">暂无待处理请求。新的建议、决策与审批会出现在这里。</p>';
  return visible.map((item) => {
    const manual = item.status === "manual_attention";
    const options = item.options || [];
    const optionHtml = options.map((option, index) => `<label class="codex-option"><input type="radio" name="option-${escapeHtml(item.id)}" value="${escapeHtml(option.id)}" ${index === 0 ? "checked" : ""}><span><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.description || "")}</small></span></label>`).join("");
    const needsText = options.some((option) => option.id === "provide_answers");
    return `<form class="codex-interaction ${escapeHtml(item.kind)}" data-interaction-id="${escapeHtml(item.id)}" data-kind="${escapeHtml(item.kind)}" data-revision="${item.revision}">
      <div class="codex-interaction-head"><span class="codex-kind">${escapeHtml(KIND_LABELS[item.kind] || item.kind)}</span><time>${escapeHtml(formatClock(item.created_at))}</time></div>
      <h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p>
      ${item.kind === "approval" ? '<div class="codex-notice">审批仅在此 Web 页面生效；Telegram 与 agent MCP 无权代答。</div>' : ""}
      ${manual ? '<div class="codex-notice codex-error">原 App Server 连接已丢失，不能安全回放。请回到 Codex 客户端手动处理。</div>' : `<div class="codex-options">${optionHtml}</div>${needsText ? '<textarea class="codex-answer-text" placeholder="选择“Provide answers”时，填写以 question id 为键的 JSON 对象"></textarea>' : ""}<button type="submit">${options.length ? "提交选择" : "确认已阅"}</button>`}
    </form>`;
  }).join("");
}

export function actionableInteractions(interactions) {
  return interactions.filter((item) => item.status === "open").length;
}

function actionBar(thread) {
  if (thread.history_mode === "paginated") {
    return thread.mode === "managed"
      ? '<div class="codex-action-bar single"><button type="button" class="danger" data-codex-action="stop">停止托管并保留记录</button></div>'
      : "";
  }
  if (thread.mode !== "managed" && !thread.workplace_id) {
    return '<div class="codex-action-bar single"><button type="button" class="primary" data-codex-action="register-workplace">登记工作地，再开始托管</button></div>';
  }
  if (thread.mode !== "managed") return '<div class="codex-action-bar single"><button type="button" class="primary" data-codex-action="manage">开始托管</button></div>';
  if (["completed", "failed"].includes(thread.phase)) {
    return '<div class="codex-action-bar single"><button type="button" class="danger" data-codex-action="stop">停止托管并保留记录</button></div>';
  }
  const pause = thread.phase === "paused"
    ? '<button type="button" data-codex-action="resume">恢复监督</button>'
    : '<button type="button" data-codex-action="pause">暂停监督</button>';
  return `<div class="codex-action-bar"><button type="button" class="primary" data-codex-action="instruction">发送指令</button>${pause}<button type="button" class="danger" data-codex-action="stop">停止托管</button></div>`;
}

function phaseTrack(phase) {
  const steps = ["观察", "对齐", "执行", "验证", "完成"];
  const index = phase === "observed" ? 0 : phase === "aligning" ? 1 : phase === "verifying" ? 3 : phase === "completed" ? 4 : 2;
  return `<div class="codex-phase-track" aria-label="监督阶段">${steps.map((label, step) => `<span class="codex-phase-step ${step < index ? "done" : step === index ? "current" : ""}"><b>${label}</b><small>${step < index ? "完成" : step === index ? PHASE_LABELS[phase] || "当前" : "待开始"}</small></span>`).join("")}</div>`;
}

function timelineEvents(directives, interactions) {
  return [
    ...directives.map((item) => ({
      at: item.created_at,
      actor: item.actor_id === "operator" ? "operator" : "Codex",
      title: `指令 · ${item.status}`,
      body: item.error ? `${item.content}\n错误：${item.error}` : item.content,
    })),
    ...interactions.map((item) => ({ at: item.created_at, actor: item.source === "agent" ? "Codex" : item.source, title: `${KIND_LABELS[item.kind] || item.kind} · ${item.status}`, body: item.title })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
}

function renderEvent(event) {
  return `<article class="codex-event ${event.actor === "operator" ? "operator" : ""}"><time>${escapeHtml(formatClock(event.at))}</time><i></i><div><strong>${escapeHtml(event.title)} · ${escapeHtml(event.actor)}</strong><p>${escapeHtml(event.body)}</p></div></article>`;
}

function ledger(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value).replace(/\n/g, "<br>")}</dd></div>`;
}

function taskTitle(thread) {
  return thread.title || thread.preview?.split("\n")[0] || `Codex ${thread.thread_id.slice(0, 8)}`;
}

function taskStateLabel(thread) {
  if (thread.mode === "managed") return PHASE_LABELS[thread.phase] || thread.phase;
  if (thread.app_status === "active") return "Codex 正在运行";
  if (thread.app_status === "idle") return "Codex 空闲";
  if (thread.app_status === "notLoaded") return "未加载";
  if (thread.app_status === "systemError") return "Codex 异常";
  return "仅观察";
}

function workplaceLabel(thread) {
  return thread.workplace_id || thread.cwd?.split("/").filter(Boolean).at(-1) || "未知工作地";
}

function historyModeNotice(thread) {
  if (thread.history_mode !== "paginated") return "";
  return '<div class="codex-notice">该任务使用分页历史；当前 Codex App Server 不能安全恢复它，因此只允许观察或停止托管。请在 Codex 中新建线程后再开始托管。</div>';
}

function historyModeLabel(mode) {
  if (mode === "paginated") return "分页（仅观察）";
  if (mode === "legacy") return "传统（可恢复）";
  return "未知";
}

function formatClock(value) {
  const date = toDate(value);
  return date ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date) : "—";
}

function formatDate(value) {
  const date = toDate(value);
  return date ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) : "—";
}

function toDate(value) {
  if (!value) return undefined;
  const normalized = typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function number(value) { return new Intl.NumberFormat("en-US").format(Number(value || 0)); }
