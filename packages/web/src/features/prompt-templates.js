import { $, copyText, escapeHtml } from "../shared/dom.js";
import { confirmNamedDeletion } from "../shared/named-confirmation.js";
import { openOperatorDialog, operatorApi, operatorSession } from "../shared/operator-session.js";

let templates = [];
let activeId;
let activeFilter = "all";

$("prompt-tag-filter-bar").addEventListener("click", (event) => {
  const button = event.target.closest("[data-prompt-filter]");
  if (!button) return;
  activeFilter = button.dataset.promptFilter;
  document.querySelectorAll("[data-prompt-filter]").forEach((item) => {
    item.classList.toggle("active", item.dataset.promptFilter === activeFilter);
  });
  renderList();
});
$("prompt-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-prompt-id]");
  if (!button) return;
  activeId = button.dataset.promptId;
  renderList();
});
$("prompt-detail").addEventListener("click", handleDetailClick);
$("edit-prompt-dialog-close").addEventListener("click", () => $("edit-prompt-dialog").close());
$("edit-prompt-cancel").addEventListener("click", () => $("edit-prompt-dialog").close());
$("edit-prompt-form").addEventListener("submit", handleSubmit);

export const promptTemplatesFeature = {
  setTemplates(items) {
    templates = items;
    activeId = templates.some((item) => item.id === activeId) ? activeId : templates[0]?.id;
    renderList();
  },
};

function renderList() {
  const filtered = activeFilter === "all"
    ? templates
    : templates.filter((item) => item.category === activeFilter);
  $("prompt-count-badge").textContent = `${templates.length} 个模版`;
  $("prompt-list").innerHTML = filtered.length ? filtered.map((item) => `
    <button type="button" class="prompt-item" data-prompt-id="${escapeHtml(item.id)}" aria-pressed="${item.id === activeId}">
      <strong>${escapeHtml(item.name)}</strong>
      <small><span class="skill-tag-badge">#${escapeHtml(item.category)}</span> ${escapeHtml(item.role)} · ${escapeHtml(item.model)}</small>
      <p>${escapeHtml(item.summary)}</p>
    </button>`).join("") : '<p class="skill-empty">当前分类没有提示词模版。</p>';
  const selected = templates.find((item) => item.id === activeId) ?? filtered[0];
  if (selected) {
    activeId = selected.id;
    renderDetail(selected);
  } else {
    $("prompt-detail").innerHTML = '<div class="skill-registry-placeholder"><h3>没有提示词</h3><p>正式定义已由 Gateway 管理。</p></div>';
  }
}

function renderDetail(item) {
  const variables = item.variables.length
    ? item.variables.map((value) => `<code>{${escapeHtml(value)}}</code>`).join(" ")
    : '<span class="muted">无变量</span>';
  $("prompt-detail").innerHTML = `
    <div class="skill-detail-head">
      <div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.summary)}</p><small><code>${escapeHtml(item.id)}</code> · revision ${item.revision}</small></div>
      <div class="skill-detail-actions">
        <button type="button" class="secondary" data-copy-prompt>复制提示词</button>
        <button type="button" class="secondary" data-edit-prompt>编辑</button>
        <button type="button" class="secondary destructive" data-delete-prompt>删除</button>
      </div>
    </div>
    <dl class="skill-detail-meta">
      <div><dt>分类</dt><dd><span class="skill-tag-badge">#${escapeHtml(item.category)}</span></dd></div>
      <div><dt>适用模型</dt><dd><code>${escapeHtml(item.model)}</code></dd></div>
      <div><dt>插值槽位</dt><dd>${variables}</dd></div>
      <div><dt>状态</dt><dd><span class="skill-registry-state active">Gateway 已治理</span></dd></div>
    </dl>
    <div class="skill-detail-section"><h4>提示词正文</h4><pre class="prompt-content"><code>${escapeHtml(item.content)}</code></pre></div>`;
}

async function handleDetailClick(event) {
  const item = templates.find((candidate) => candidate.id === activeId);
  if (!item) return;
  const copy = event.target.closest("[data-copy-prompt]");
  if (copy) {
    await copyText(item.content);
    copy.textContent = "已复制正文";
    window.setTimeout(() => { copy.textContent = "复制提示词"; }, 2_000);
    return;
  }
  if (event.target.closest("[data-edit-prompt]")) return openEditDialog(item);
  if (!event.target.closest("[data-delete-prompt]")) return;
  if (!ensureOperator()) return;
  if (!await confirmNamedDeletion({ kind: "提示词模版", name: item.name })) return;
  await operatorApi(`/api/ability-templates/prompt/${encodeURIComponent(item.id)}`, { method: "DELETE" });
  templates = templates.filter((candidate) => candidate.id !== item.id);
  activeId = templates[0]?.id;
  renderList();
}

function openEditDialog(item) {
  if (!ensureOperator()) return;
  $("edit-prompt-id").value = item.id;
  $("edit-prompt-name").value = item.name;
  $("edit-prompt-category").value = item.category;
  $("edit-prompt-role").value = item.role;
  $("edit-prompt-model").value = item.model;
  $("edit-prompt-summary").value = item.summary;
  $("edit-prompt-variables").value = item.variables.join(", ");
  $("edit-prompt-content").value = item.content;
  setStatus("");
  $("edit-prompt-dialog").showModal();
  window.setTimeout(() => $("edit-prompt-name").focus(), 0);
}

async function handleSubmit(event) {
  event.preventDefault();
  const id = $("edit-prompt-id").value;
  const submit = $("edit-prompt-submit");
  submit.disabled = true;
  setStatus("正在保存到 Gateway…");
  try {
    const updated = await operatorApi(`/api/ability-templates/prompt/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: $("edit-prompt-name").value,
        category: $("edit-prompt-category").value,
        role: $("edit-prompt-role").value,
        model: $("edit-prompt-model").value,
        summary: $("edit-prompt-summary").value,
        variables: $("edit-prompt-variables").value.split(/[,，\s]+/).map((value) => value.replace(/^\{+|\}+$/g, "")).filter(Boolean),
        content: $("edit-prompt-content").value,
      }),
    });
    templates = templates.map((item) => item.id === id ? updated : item);
    $("edit-prompt-dialog").close();
    renderList();
  } catch (error) {
    setStatus(`保存失败：${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
}

function ensureOperator() {
  if (operatorSession.authenticated) return true;
  openOperatorDialog();
  return false;
}

function setStatus(message, error = false) {
  $("edit-prompt-status").className = `operator-login-status${error ? " error" : ""}`;
  $("edit-prompt-status").textContent = message;
}
