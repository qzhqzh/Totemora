import { $, escapeHtml } from "../shared/dom.js";
import { confirmNamedDeletion } from "../shared/named-confirmation.js";
import { openOperatorDialog, operatorApi, operatorSession } from "../shared/operator-session.js";

let templates = [];
let activeId;

$("workflow-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-workflow-id]");
  if (!button) return;
  activeId = button.dataset.workflowId;
  renderList();
});
$("workflow-detail").addEventListener("click", handleDetailClick);
$("edit-workflow-dialog-close").addEventListener("click", () => $("edit-workflow-dialog").close());
$("edit-workflow-cancel").addEventListener("click", () => $("edit-workflow-dialog").close());
$("edit-workflow-form").addEventListener("submit", handleSubmit);

export const workflowTemplatesFeature = {
  setTemplates(items) {
    templates = items;
    activeId = templates.some((item) => item.id === activeId) ? activeId : templates[0]?.id;
    renderList();
  },
};

function renderList() {
  const badge = document.querySelector("#ability-tab-workflow .prompt-count-badge");
  if (badge) badge.textContent = `${templates.length} 条管线`;
  $("workflow-list").innerHTML = templates.length ? templates.map((item) => `
    <button type="button" class="workflow-item" data-workflow-id="${escapeHtml(item.id)}" aria-pressed="${item.id === activeId}">
      <strong>${escapeHtml(item.name)}</strong>
      <small><code>${escapeHtml(item.id)}</code> · ${item.steps.length} 个协同阶段</small>
      <small class="workflow-trigger">触发：${escapeHtml(item.trigger)}</small>
    </button>`).join("") : '<p class="skill-empty">当前没有正式工作流。</p>';
  const selected = templates.find((item) => item.id === activeId) ?? templates[0];
  if (selected) {
    activeId = selected.id;
    renderDetail(selected);
  } else {
    $("workflow-detail").innerHTML = '<div class="skill-registry-placeholder"><h3>没有工作流</h3><p>正式定义已由 Gateway 管理。</p></div>';
  }
}

function renderDetail(item) {
  $("workflow-detail").innerHTML = `
    <div class="skill-detail-head">
      <div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.summary)}</p><small><code>${escapeHtml(item.id)}</code> · revision ${item.revision}</small></div>
      <div class="skill-detail-actions">
        <button type="button" class="secondary" data-edit-workflow>编辑</button>
        <button type="button" class="secondary destructive" data-delete-workflow>删除</button>
        <span class="skill-registry-state active">Gateway 已治理</span>
      </div>
    </div>
    <dl class="skill-detail-meta">
      <div><dt>触发条件</dt><dd>${escapeHtml(item.trigger)}</dd></div>
      <div><dt>协同阶段</dt><dd>${item.steps.length} 个流转门禁</dd></div>
      <div><dt>证据审计</dt><dd>全链路 Trace 记录</dd></div>
      <div><dt>状态</dt><dd><span class="skill-registry-state active">活跃</span></dd></div>
    </dl>
    <div class="skill-detail-section"><h4>流水线协同阶段</h4><div class="pipeline-steps">
      ${item.steps.map((step, index) => `<div class="pipeline-step">
        <span class="pipeline-step-num">${index + 1}</span>
        <div><strong>${escapeHtml(step.name)}</strong><small>${escapeHtml(step.actor)}</small><p>${escapeHtml(step.desc)}</p></div>
      </div>`).join("")}
    </div></div>`;
}

async function handleDetailClick(event) {
  const item = templates.find((candidate) => candidate.id === activeId);
  if (!item) return;
  if (event.target.closest("[data-edit-workflow]")) return openEditDialog(item);
  if (!event.target.closest("[data-delete-workflow]")) return;
  if (!ensureOperator()) return;
  if (!await confirmNamedDeletion({ kind: "工作流", name: item.name })) return;
  await operatorApi(`/api/ability-templates/workflow/${encodeURIComponent(item.id)}`, { method: "DELETE" });
  templates = templates.filter((candidate) => candidate.id !== item.id);
  activeId = templates[0]?.id;
  renderList();
}

function openEditDialog(item) {
  if (!ensureOperator()) return;
  $("edit-workflow-id").value = item.id;
  $("edit-workflow-name").value = item.name;
  $("edit-workflow-trigger").value = item.trigger;
  $("edit-workflow-summary").value = item.summary;
  $("edit-workflow-steps").value = JSON.stringify(item.steps, null, 2);
  setStatus("");
  $("edit-workflow-dialog").showModal();
  window.setTimeout(() => $("edit-workflow-name").focus(), 0);
}

async function handleSubmit(event) {
  event.preventDefault();
  const id = $("edit-workflow-id").value;
  const submit = $("edit-workflow-submit");
  submit.disabled = true;
  setStatus("正在保存到 Gateway…");
  try {
    const updated = await operatorApi(`/api/ability-templates/workflow/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: $("edit-workflow-name").value,
        trigger: $("edit-workflow-trigger").value,
        summary: $("edit-workflow-summary").value,
        steps: parseSteps($("edit-workflow-steps").value),
      }),
    });
    templates = templates.map((item) => item.id === id ? updated : item);
    $("edit-workflow-dialog").close();
    renderList();
  } catch (error) {
    setStatus(`保存失败：${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
}

function parseSteps(source) {
  const value = source.trim();
  if (!value) throw new Error("至少需要一个协同阶段");
  if (value.startsWith("[") || value.startsWith("{")) {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, actor, desc] = line.split("|").map((part) => part.trim());
    return { name, actor, desc };
  });
}

function ensureOperator() {
  if (operatorSession.authenticated) return true;
  openOperatorDialog();
  return false;
}

function setStatus(message, error = false) {
  $("edit-workflow-status").className = `operator-login-status${error ? " error" : ""}`;
  $("edit-workflow-status").textContent = message;
}
