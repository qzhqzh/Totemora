import { $, copyText, escapeHtml, formatObservatoryTime } from "../shared/dom.js";
import { operatorApi, operatorSession, openOperatorDialog } from "../shared/operator-session.js";

const REFRESH_INTERVAL = 30_000;

export function createCodexScheduledSubscriptionsFeature() {
  let overview;
  let pollTimer;
  let loading = false;

  bindEvents();
  renderLocked();

  return {
    refreshProtected: refresh,
    lockProtected: renderLocked,
    releaseProtectedResources: release,
  };

  async function refresh() {
    cancelPoll();
    if (!operatorSession.authenticated || loading) return;
    loading = true;
    try {
      overview = await operatorApi("/api/codex/scheduled-subscriptions");
      render();
    } catch (error) {
      if (error.status !== 401) renderError(error.message);
    } finally {
      loading = false;
      schedulePoll();
    }
  }

  function render() {
    const subscriptions = overview?.subscriptions ?? [];
    const limit = overview?.subscription_limit ?? 3;
    $("codex-subscription-count").textContent = `${subscriptions.length}/${limit}`;
    $("codex-subscription-list").innerHTML = subscriptions.length
      ? subscriptions.map(renderSubscription).join("")
      : '<p class="codex-subscription-empty">尚未订阅。只有在这里创建并绑定凭证的定时任务才会发群。</p>';
    const available = Boolean(overview?.mcp_endpoint && overview?.telegram_targets?.length);
    const create = $("codex-subscription-open");
    create.disabled = !available || subscriptions.length >= limit;
    $("codex-subscription-state").textContent = !overview?.mcp_endpoint
      ? "缺少公开 HTTPS 地址"
      : !overview?.telegram_targets?.length
        ? "Telegram 群未配置"
        : subscriptions.length >= limit ? "已达订阅上限" : "仅显式订阅投递 · 每份每天最多 1 条";
  }

  function renderSubscription(subscription) {
    const status = subscription.last_delivery_status === "delivered" ? "已投递"
      : subscription.last_delivery_status === "failed" ? "投递失败"
      : subscription.last_delivery_status === "uncertain" ? "结果待确认" : "等待首次运行";
    const statusClass = subscription.last_delivery_status === "delivered" ? "success"
      : ["failed", "uncertain"].includes(subscription.last_delivery_status) ? "attention" : "";
    const last = subscription.last_delivered_at
      ? formatObservatoryTime(subscription.last_delivered_at)
      : subscription.last_run_key ? escapeHtml(subscription.last_run_key) : "尚无运行记录";
    return `<article class="codex-subscription-item">
      <div><strong>${escapeHtml(subscription.name)}</strong><span>群 …${escapeHtml(subscription.target_chat_id.slice(-4))}</span></div>
      <p><span class="codex-delivery-state ${statusClass}">${status}</span><small>${last}</small></p>
      ${subscription.last_error ? `<em>${escapeHtml(subscription.last_error)}</em>` : ""}
      <button type="button" class="secondary" data-revoke-subscription="${escapeHtml(subscription.id)}" data-revision="${subscription.revision}">取消订阅</button>
    </article>`;
  }

  function renderLocked() {
    cancelPoll();
    overview = undefined;
    $("codex-subscription-count").textContent = "0/3";
    $("codex-subscription-state").textContent = "登录后管理";
    $("codex-subscription-list").innerHTML = '<p class="codex-subscription-empty">登录后可订阅最多 3 个定时任务。</p>';
    $("codex-subscription-open").disabled = false;
    clearCredential();
  }

  function renderError(message) {
    $("codex-subscription-state").textContent = "读取失败";
    $("codex-subscription-list").innerHTML = `<p class="codex-subscription-empty codex-error">${escapeHtml(message)}</p>`;
  }

  function openCreateDialog() {
    if (!operatorSession.authenticated) return openOperatorDialog();
    if (!overview) return;
    const select = $("codex-subscription-target");
    select.innerHTML = overview.telegram_targets.map(({ chat_id: chatId }) => (
      `<option value="${escapeHtml(chatId)}">Telegram 群 …${escapeHtml(chatId.slice(-4))}</option>`
    )).join("");
    $("codex-subscription-name").value = "";
    setFormStatus("为一个明确的定时任务创建专属凭证；凭证只显示一次。", false);
    $("codex-subscription-dialog").showModal();
    window.setTimeout(() => $("codex-subscription-name").focus(), 0);
  }

  async function submitSubscription(event) {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    setFormStatus("正在创建受限订阅…", false);
    try {
      const result = await operatorApi("/api/codex/scheduled-subscriptions", {
        method: "POST",
        body: JSON.stringify({
          name: $("codex-subscription-name").value,
          target_chat_id: $("codex-subscription-target").value,
        }),
      });
      $("codex-subscription-dialog").close();
      showCredential(result);
      await refresh();
    } catch (error) {
      setFormStatus(error.message, true);
      if (error.status === 409) await refresh();
    } finally {
      submit.disabled = false;
    }
  }

  function showCredential(result) {
    $("codex-credential-endpoint").value = result.credential.mcp_endpoint;
    $("codex-credential-token").value = result.credential.bearer_token;
    $("codex-credential-prompt").value = result.credential.prompt;
    $("codex-credential-title").textContent = result.subscription.name;
    $("codex-credential-status").textContent = "请按项目文档配置本地 Codex MCP；关闭后 Token 不再显示。";
    $("codex-credential-dialog").showModal();
  }

  async function revokeSubscription(button) {
    const subscription = overview?.subscriptions.find((item) => item.id === button.dataset.revokeSubscription);
    if (!subscription || !window.confirm(`取消“${subscription.name}”的 Telegram 订阅？现有凭证会立即失效。`)) return;
    button.disabled = true;
    try {
      await operatorApi(`/api/codex/scheduled-subscriptions/${encodeURIComponent(subscription.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ expected_revision: Number(button.dataset.revision) }),
      });
      await refresh();
    } catch (error) {
      renderError(error.message);
      if (error.status === 409) await refresh();
    } finally {
      button.disabled = false;
    }
  }

  function bindEvents() {
    $("codex-subscription-open").addEventListener("click", openCreateDialog);
    $("codex-subscription-form").addEventListener("submit", submitSubscription);
    $("codex-subscription-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-revoke-subscription]");
      if (button) void revokeSubscription(button);
    });
    document.querySelectorAll("[data-codex-scheduled-close]").forEach((button) => {
      button.addEventListener("click", () => $(button.dataset.codexScheduledClose).close());
    });
    $("codex-credential-dialog").addEventListener("close", clearCredential);
    $("codex-credential-dialog").addEventListener("click", (event) => {
      const button = event.target.closest("[data-copy-credential]");
      if (!button) return;
      const field = $(button.dataset.copyCredential);
      void copyText(field.value)
        .then(() => { $("codex-credential-status").textContent = `${button.textContent}完成`; })
        .catch((error) => { $("codex-credential-status").textContent = error.message; });
    });
    document.addEventListener("visibilitychange", () => {
      cancelPoll();
      if (!document.hidden) void refresh();
      else schedulePoll();
    });
  }

  function setFormStatus(message, error) {
    $("codex-subscription-form-status").className = `operator-login-status${error ? " error" : ""}`;
    $("codex-subscription-form-status").textContent = message;
  }

  function clearCredential() {
    ["codex-credential-endpoint", "codex-credential-token", "codex-credential-prompt"].forEach((id) => { $(id).value = ""; });
  }

  function release() {
    cancelPoll();
    clearCredential();
  }

  function schedulePoll() {
    cancelPoll();
    if (operatorSession.authenticated) pollTimer = window.setTimeout(() => void refresh(), REFRESH_INTERVAL);
  }

  function cancelPoll() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}
