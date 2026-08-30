import { $ } from "../shared/dom.js";
import { operatorApi, operatorSession, openOperatorDialog } from "../shared/operator-session.js";
import {
  actionableInteractions, filterThreads, renderConnection, renderDetail, renderInteractions, renderTaskList,
} from "../shared/codex-view.js";

const ACTIVE_INTERVAL = 5_000;
const HIDDEN_INTERVAL = 30_000;

export function createCodexSupervisorFeature() {
  const state = { status: undefined, threads: [], interactions: [], detail: undefined, selectedId: undefined, mode: "all", query: "" };
  let pollTimer;
  let loading = false;

  bindEvents();
  renderLocked();

  return {
    refreshProtected: refresh,
    lockProtected: renderLocked,
    releaseProtectedResources: cancelPoll,
  };

  async function refresh({ announce = false, rescan = false } = {}) {
    cancelPoll();
    if (!operatorSession.authenticated || loading) return;
    loading = true;
    $("codex-refresh").disabled = true;
    try {
      if (rescan) {
        say("正在从共享 App Server 扫描运行会话…");
        await post("/api/codex/refresh", {});
      }
      const [status, threads, interactionResult] = await Promise.all([
        operatorApi("/api/codex/status"),
        loadThreads(),
        operatorApi("/api/codex/interactions?limit=100"),
      ]);
      state.status = status;
      state.threads = threads;
      state.interactions = interactionResult.interactions;
      chooseSelectedThread();
      state.detail = state.selectedId ? await operatorApi(`/api/codex/threads/${encodeURIComponent(state.selectedId)}`) : undefined;
      renderAll();
      if (announce) say(rescan ? "运行会话已重新扫描并刷新" : "Codex 现场已刷新");
    } catch (error) {
      if (error.status !== 401) showConnectionError(error.message);
    } finally {
      loading = false;
      $("codex-refresh").disabled = false;
      schedulePoll();
    }
  }

  function chooseSelectedThread() {
    if (state.threads.some((thread) => thread.thread_id === state.selectedId)) return;
    state.selectedId = state.threads.find((thread) => thread.mode === "managed")?.thread_id ?? state.threads[0]?.thread_id;
  }

  function renderAll() {
    const runningThreads = state.status?.running_threads
      ?? state.threads.filter((thread) => thread.app_status === "active").length;
    const connection = renderConnection(state.status ? { ...state.status, running_threads: runningThreads } : undefined);
    $("codex-connection").className = connection.className;
    $("codex-connection").innerHTML = `<i></i>${connection.label}`;
    $("codex-running").textContent = connection.running;
    $("codex-managed").textContent = connection.managed;
    $("codex-socket").textContent = connection.socket;
    $("codex-scan").textContent = connection.scan;
    renderThreads();
    $("codex-detail").innerHTML = renderDetail(state.detail);
    $("codex-interaction-list").innerHTML = renderInteractions(state.interactions);
    const decisions = actionableInteractions(state.interactions);
    $("codex-decision-count").textContent = decisions;
    $("codex-mobile-decision-count").textContent = decisions;
  }

  function renderThreads() {
    const visible = filterThreads(state.threads, state.mode, state.query);
    $("codex-task-list").innerHTML = renderTaskList(visible, state.selectedId);
    $("codex-task-count").textContent = visible.length;
    $("codex-mobile-task-count").textContent = state.threads.length;
  }

  function renderLocked() {
    cancelPoll();
    state.status = undefined;
    state.threads = [];
    state.interactions = [];
    state.detail = undefined;
    state.selectedId = undefined;
    const connection = renderConnection();
    $("codex-connection").className = "";
    $("codex-connection").innerHTML = `<i></i>${connection.label}`;
    $("codex-running").textContent = connection.running;
    $("codex-managed").textContent = connection.managed;
    $("codex-socket").textContent = connection.socket;
    $("codex-scan").textContent = connection.scan;
    $("codex-task-list").innerHTML = '<p class="codex-empty">登录后显示共享 App Server 中的全部任务。</p>';
    $("codex-detail").innerHTML = renderDetail();
    $("codex-interaction-list").innerHTML = '<p class="codex-empty">登录后显示待处理决策与审批。</p>';
    ["codex-task-count", "codex-mobile-task-count", "codex-decision-count", "codex-mobile-decision-count"].forEach((id) => $(id).textContent = "0");
  }

  async function selectThread(threadId) {
    state.selectedId = threadId;
    renderThreads();
    setMobileTab("detail");
    $("codex-detail").innerHTML = '<p class="codex-empty">正在读取任务详情…</p>';
    try {
      state.detail = await operatorApi(`/api/codex/threads/${encodeURIComponent(threadId)}`);
      $("codex-detail").innerHTML = renderDetail(state.detail);
    } catch (error) {
      $("codex-detail").innerHTML = `<p class="codex-empty codex-error">${safe(error.message)}</p>`;
    }
  }

  async function control(action) {
    const thread = selectedThread();
    if (!thread) return;
    if (action === "register-workplace") return openWorkplaceDialog(thread);
    if (action === "manage") return openManageDialog(thread);
    if (action === "instruction") return openInstructionDialog();
    if (action === "stop" && !window.confirm("停止 Totemora 托管？Codex 任务本身不会被删除。")) return;
    await mutate(`/api/codex/threads/${encodeURIComponent(thread.thread_id)}/${action}`, {
      expected_revision: thread.revision,
    }, `${action === "pause" ? "已暂停" : action === "resume" ? "已恢复" : "已停止"}监督`);
  }

  async function submitManage(event) {
    event.preventDefault();
    const thread = selectedThread();
    if (!thread) return;
    const status = $("codex-manage-status");
    status.textContent = "正在建立监督目标…";
    try {
      await post(`/api/codex/threads/${encodeURIComponent(thread.thread_id)}/manage`, {
        expected_revision: thread.revision,
        objective: $("codex-manage-objective").value,
        token_budget: Number($("codex-manage-budget").value),
        deadline_at: new Date($("codex-manage-deadline").value).toISOString(),
      });
      $("codex-manage-dialog").close();
      say("任务已进入托管队列");
      await refresh();
    } catch (error) { showDialogError(status, error); }
  }

  async function submitWorkplace(event) {
    event.preventDefault();
    const thread = selectedThread();
    if (!thread) return;
    const status = $("codex-workplace-status");
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    status.className = "operator-login-status";
    status.textContent = "正在登记工作地…";
    submit.disabled = true;
    try {
      await post("/api/workplaces", {
        name: $("codex-workplace-name").value,
        path: $("codex-workplace-path").value,
      });
      $("codex-workplace-dialog").close();
      say("工作地已登记；Observer 会在约 15 秒内关联任务，随后即可开始托管。");
      await refresh();
    } catch (error) {
      if (error.status === 409) {
        $("codex-workplace-dialog").close();
        say("这个路径已经登记；Observer 会在约 15 秒内关联任务，随后即可开始托管。");
        await refresh();
      } else {
        showDialogError(status, error);
      }
    } finally {
      submit.disabled = false;
    }
  }

  async function submitInstruction(event) {
    event.preventDefault();
    const thread = selectedThread();
    if (!thread) return;
    const status = $("codex-instruction-status");
    status.textContent = "正在写入指令队列…";
    try {
      await post(`/api/codex/threads/${encodeURIComponent(thread.thread_id)}/instructions`, {
        content: $("codex-instruction-content").value,
        idempotency_key: crypto.randomUUID(),
      });
      $("codex-instruction-dialog").close();
      $("codex-instruction-content").value = "";
      say("指令已入队");
      await refresh();
    } catch (error) { showDialogError(status, error); }
  }

  async function submitInteraction(event) {
    const form = event.target.closest(".codex-interaction");
    if (!form) return;
    event.preventDefault();
    const selected = form.querySelector('input[type="radio"]:checked')?.value;
    const responseText = form.querySelector(".codex-answer-text")?.value.trim()
      || (!form.querySelector('input[type="radio"]') ? "acknowledged" : "");
    if (selected === "provide_answers") {
      try { JSON.parse(responseText); } catch { say("结构化答案必须是有效 JSON", true); return; }
    }
    const approval = form.dataset.kind === "approval";
    const path = approval ? `/api/codex/approvals/${encodeURIComponent(form.dataset.interactionId)}/respond`
      : `/api/codex/interactions/${encodeURIComponent(form.dataset.interactionId)}/answer`;
    await mutate(path, {
      expected_revision: Number(form.dataset.revision),
      ...(selected ? { selected_option_id: selected } : {}),
      ...(responseText ? { response_text: responseText } : {}),
    }, approval ? "审批响应已提交" : "决策已提交");
  }

  async function mutate(path, body, success) {
    try {
      await post(path, body);
      say(success);
      await refresh();
    } catch (error) {
      say(error.message, true);
      if (error.status === 409) await refresh();
    }
  }

  function bindEvents() {
    $("codex-refresh").addEventListener("click", () => operatorSession.authenticated ? void refresh({ announce: true, rescan: true }) : openOperatorDialog());
    $("codex-search").addEventListener("input", (event) => { state.query = event.target.value; renderThreads(); });
    document.querySelector(".codex-task-filters").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (!button) return;
      state.mode = button.dataset.mode;
      document.querySelectorAll("[data-mode]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      renderThreads();
    });
    $("codex-task-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-thread-id]");
      if (button) void selectThread(button.dataset.threadId);
    });
    document.querySelector(".codex-mobile-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-codex-tab]");
      if (button) setMobileTab(button.dataset.codexTab);
    });
    $("codex-detail").addEventListener("click", (event) => {
      const button = event.target.closest("[data-codex-action]");
      if (button) void control(button.dataset.codexAction);
    });
    $("codex-interaction-list").addEventListener("submit", (event) => void submitInteraction(event));
    $("codex-workplace-form").addEventListener("submit", (event) => void submitWorkplace(event));
    $("codex-manage-form").addEventListener("submit", (event) => void submitManage(event));
    $("codex-instruction-form").addEventListener("submit", (event) => void submitInstruction(event));
    document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => $(button.dataset.closeDialog).close()));
    document.addEventListener("visibilitychange", () => { cancelPoll(); if (!document.hidden) void refresh(); else schedulePoll(); });
  }

  function openWorkplaceDialog(thread) {
    $("codex-workplace-name").value = workplaceName(thread);
    $("codex-workplace-path").value = thread.cwd;
    $("codex-workplace-status").className = "operator-login-status";
    $("codex-workplace-status").textContent = "路径来自当前 Codex 任务，登记后无需离开本页。";
    $("codex-workplace-dialog").showModal();
    window.setTimeout(() => $("codex-workplace-name").select(), 0);
  }

  function openManageDialog(thread) {
    $("codex-manage-objective").value = thread.goal_objective || thread.preview || thread.title || "完成当前 Codex 任务并提供可验证结果";
    $("codex-manage-budget").value = "150000";
    $("codex-manage-deadline").value = localDateTime(new Date(Date.now() + 72 * 60 * 60 * 1_000));
    $("codex-manage-status").textContent = "默认预算 150,000 tokens，截止时间 72 小时。";
    $("codex-manage-dialog").showModal();
  }

  function openInstructionDialog() {
    $("codex-instruction-status").textContent = "指令会持久化后再投递。";
    $("codex-instruction-dialog").showModal();
    window.setTimeout(() => $("codex-instruction-content").focus(), 0);
  }

  function setMobileTab(tab) {
    document.body.dataset.codexTab = tab;
    document.querySelectorAll(".codex-mobile-tabs [data-codex-tab]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.codexTab === tab)));
  }

  function schedulePoll() {
    cancelPoll();
    if (!operatorSession.authenticated) return;
    pollTimer = window.setTimeout(() => void refresh(), document.hidden ? HIDDEN_INTERVAL : ACTIVE_INTERVAL);
  }

  function cancelPoll() { if (pollTimer) window.clearTimeout(pollTimer); pollTimer = undefined; }
  function selectedThread() { return state.threads.find((thread) => thread.thread_id === state.selectedId); }
  async function loadThreads() {
    const threads = [];
    for (let offset = 0; offset < 5_000; offset += 500) {
      const page = await operatorApi(`/api/codex/threads?limit=500&offset=${offset}`);
      threads.push(...page.threads);
      if (page.threads.length < 500) break;
    }
    return threads;
  }
  function post(path, body) { return operatorApi(path, { method: "POST", body: JSON.stringify(body) }); }
  function say(message, error = false) { $("codex-live").textContent = message; if (error) showConnectionError(message); }
  function showConnectionError(message) { $("codex-connection").className = "error"; $("codex-connection").innerHTML = `<i></i>${safe(message)}`; }
  function showDialogError(node, error) { node.className = "operator-login-status error"; node.textContent = error.message; if (error.status === 409) void refresh(); }
}

function localDateTime(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function workplaceName(thread) {
  return thread.cwd?.replace(/\/+$/, "").split("/").filter(Boolean).at(-1)
    || thread.title
    || "Codex 工作地";
}

function safe(value) {
  const node = document.createElement("span");
  node.textContent = String(value);
  return node.innerHTML;
}
