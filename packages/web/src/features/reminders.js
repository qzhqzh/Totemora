import { $, escapeHtml } from "../shared/dom.js";
import { openOperatorDialog, operatorApi, operatorSession } from "../shared/operator-session.js";

let reminders = [];

$("refresh-reminders").addEventListener("click", async (event) => {
  if (!operatorSession.authenticated) return openOperatorDialog();
  const button = event.currentTarget;
  button.disabled = true;
  try { await loadReminders(); }
  finally { button.disabled = false; }
});
$("reminder-filter-status").addEventListener("change", () => void loadReminders());
$("reminder-create-form").addEventListener("submit", createReminder);
$("reminder-list").addEventListener("click", updateReminderStatus);

export const remindersFeature = {
  loadReminders,
  refreshProtected() { void loadReminders(); },
  lockProtected() {
    reminders = [];
    renderLocked();
  },
};

async function loadReminders() {
  if (!operatorSession.authenticated) {
    renderLocked();
    return;
  }
  const status = $("reminder-filter-status").value;
  setSummary("正在读取事项与今日去重账本…", "loading");
  try {
    reminders = (await operatorApi(`/api/reminders?status=${encodeURIComponent(status)}`)).reminders || [];
    renderReminders();
  } catch (error) {
    reminders = [];
    setSummary(`事项读取失败：${error.message}`, "error");
    $("reminder-list").innerHTML = '<div class="reminder-empty"><b>暂时无法读取事项</b><p>检查操作员登录与 Gateway 状态后重试。</p></div>';
  }
}

function renderLocked() {
  setSummary("输入操作员 Token 后可查看和管理个人事项。", "");
  $("reminder-list").innerHTML = '<div class="reminder-empty"><b>事项内容已保护</b><p>标题、截止日与投递状态只对操作员开放。</p></div>';
  setFormAvailability(false);
}

function renderReminders() {
  const active = reminders.filter((item) => item.status === "active").length;
  const urgent = reminders.filter((item) => item.status === "active" && item.importance === 5).length;
  setSummary(
    reminders.length
      ? `${reminders.length} 条事项 · ${active} 条进行中${urgent ? ` · ${urgent} 条高重要度` : ""} · 北京时间自动提醒`
      : "当前筛选下没有事项。",
    active ? "ready" : "",
  );
  setFormAvailability(true);
  $("reminder-list").innerHTML = reminders.map((item) => {
    const state = ({ active: "进行中", completed: "已完成", expired: "已过期" })[item.status] || item.status;
    const action = item.status === "active"
      ? '<button type="button" class="secondary" data-reminder-action="complete">标记完成</button>'
      : '<button type="button" class="secondary" data-reminder-action="reopen">恢复事项</button>';
    return `<article class="reminder-card ${escapeHtml(item.status)} importance-${item.importance}" data-reminder-id="${escapeHtml(item.id)}">
      <header><div><small>重要度 ${item.importance}</small><h3>${escapeHtml(item.title)}</h3></div><span>${escapeHtml(state)}</span></header>
      <dl><div><dt>截止日</dt><dd>${escapeHtml(item.deadline_local_date)}</dd></div><div><dt>时区</dt><dd>Asia/Shanghai</dd></div></dl>
      <footer>${action}<small role="status" aria-live="polite">每个时间窗与目标通道独立幂等</small></footer>
    </article>`;
  }).join("") || '<div class="reminder-empty"><b>还没有匹配的事项</b><p>从左侧创建一条；系统不会删除旧记录，只会完成、过期或恢复。</p></div>';
}

async function createReminder(event) {
  event.preventDefault();
  if (!operatorSession.authenticated) return openOperatorDialog();
  const button = event.submitter;
  const status = $("reminder-form-status");
  button.disabled = true;
  status.className = "form-status";
  status.textContent = "正在保存事项…";
  try {
    await operatorApi("/api/reminders", {
      method: "POST",
      body: JSON.stringify({
        title: $("reminder-title").value.trim(),
        deadline_local_date: $("reminder-deadline").value,
        importance: Number($("reminder-importance").value),
      }),
    });
    $("reminder-title").value = "";
    $("reminder-filter-status").value = "active";
    status.textContent = "事项已保存，并已加入北京时间提醒调度。";
    await loadReminders();
  } catch (error) {
    status.className = "form-status error";
    status.textContent = `保存失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function updateReminderStatus(event) {
  const button = event.target.closest("[data-reminder-action]");
  if (!button) return;
  const card = button.closest("[data-reminder-id]");
  const feedback = card.querySelector("footer small");
  button.disabled = true;
  feedback.textContent = button.dataset.reminderAction === "complete" ? "正在标记完成…" : "正在恢复事项…";
  try {
    await operatorApi(`/api/reminders/${encodeURIComponent(card.dataset.reminderId)}/${button.dataset.reminderAction}`, {
      method: "POST",
    });
    await loadReminders();
  } catch (error) {
    feedback.classList.add("error");
    feedback.textContent = `更新失败：${error.message}`;
    button.disabled = false;
  }
}

function setSummary(text, state) {
  $("reminder-summary").className = `notification-summary${state ? ` ${state}` : ""}`;
  $("reminder-summary").textContent = text;
}

function setFormAvailability(enabled) {
  $("reminder-create-form").querySelectorAll("input, select, button")
    .forEach((control) => { control.disabled = !enabled; });
}
