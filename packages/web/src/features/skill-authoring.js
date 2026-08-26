import { skillsRoute } from "../shared/app-context.js";
import { $, escapeHtml } from "../shared/dom.js";
import { confirmNamedDeletion } from "../shared/named-confirmation.js";
import { openOperatorDialog, operatorApi, operatorSession } from "../shared/operator-session.js";
import { skillRegistryFeature } from "./skill-registry.js";

const PRESET_TAGS = ["image", "design", "write", "git", "finance", "ops", "security", "data", "review"];
const selected = { new: new Set(), edit: new Set() };

$("create-skill-button").addEventListener("click", openCreateDialog);
$("create-skill-index-button").addEventListener("click", openCreateDialog);
$("create-skill-dialog-close").addEventListener("click", () => $("create-skill-dialog").close());
$("create-skill-cancel").addEventListener("click", () => $("create-skill-dialog").close());
$("edit-skill-dialog-close").addEventListener("click", () => $("edit-skill-dialog").close());
$("edit-skill-cancel").addEventListener("click", () => $("edit-skill-dialog").close());
$("create-skill-form").addEventListener("submit", handleCreate);
$("edit-skill-form").addEventListener("submit", handleEdit);
$("skill-registry-detail").addEventListener("click", handleDetailAction);
configureTagEditor("new");
configureTagEditor("edit");

export const skillAuthoringFeature = {};

function openCreateDialog() {
  if (!ensureOperator()) return;
  selected.new.clear();
  renderTags("new");
  setStatus("create-skill-status", "创建 Skill 需要已验证的操作员身份。");
  $("create-skill-dialog").showModal();
  window.setTimeout(() => $("new-skill-id").focus(), 0);
}

async function openEditDialog(id) {
  if (!ensureOperator()) return;
  const skill = skillRegistryFeature.list().find((item) => item.id === id);
  if (!skill) return;
  $("edit-skill-id").value = skill.id;
  $("edit-skill-name").value = skill.name;
  $("edit-skill-description").value = skill.description;
  selected.edit = new Set(skill.tags ?? []);
  renderTags("edit");
  setStatus("edit-skill-status", "正在读取当前 SKILL.md 内容…");
  $("edit-skill-dialog").showModal();
  try {
    const file = await operatorApi(`/api/skills/registry/${encodeURIComponent(skill.id)}/file?path=SKILL.md`);
    const body = file.content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? file.content;
    $("edit-skill-content").value = body.trim();
    setStatus("edit-skill-status", "保存修改需要已验证的操作员身份。");
  } catch (error) {
    $("edit-skill-content").value = "";
    setStatus("edit-skill-status", `读取 SKILL.md 失败：${error.message}，可在下方重新编写。`, true);
  }
}

async function handleCreate(event) {
  event.preventDefault();
  const submit = $("create-skill-submit");
  submit.disabled = true;
  setStatus("create-skill-status", "正在生成 Skill 包并写入仓库…");
  try {
    const created = await operatorApi("/api/skills/registry", {
      method: "POST",
      body: JSON.stringify({
        id: $("new-skill-id").value,
        name: $("new-skill-name").value,
        description: $("new-skill-description").value,
        content: $("new-skill-content").value,
        tags: [...selected.new],
      }),
    });
    $("create-skill-dialog").close();
    $("create-skill-form").reset();
    selected.new.clear();
    await skillRegistryFeature.loadRegistry({ keepSelection: false, refresh: true });
    skillRegistryFeature.select(created.id);
    updateSkillUrl(created.id);
  } catch (error) {
    setStatus("create-skill-status", `创建失败：${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
}

async function handleEdit(event) {
  event.preventDefault();
  const id = $("edit-skill-id").value;
  const submit = $("edit-skill-submit");
  submit.disabled = true;
  setStatus("edit-skill-status", "正在更新 Skill 包并写入仓库…");
  try {
    const updated = await operatorApi(`/api/skills/registry/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: $("edit-skill-name").value,
        description: $("edit-skill-description").value,
        content: $("edit-skill-content").value,
        tags: [...selected.edit],
      }),
    });
    $("edit-skill-dialog").close();
    await skillRegistryFeature.loadRegistry({ keepSelection: true, refresh: true });
    skillRegistryFeature.select(updated.id, "SKILL.md");
  } catch (error) {
    setStatus("edit-skill-status", `修改失败：${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
}

async function handleDetailAction(event) {
  const edit = event.target.closest("[data-edit-skill]");
  if (edit) return void openEditDialog(edit.dataset.editSkill);
  const remove = event.target.closest("[data-delete-skill]");
  if (!remove || !ensureOperator()) return;
  const skill = skillRegistryFeature.list().find((item) => item.id === remove.dataset.deleteSkill);
  if (!skill || !await confirmNamedDeletion({ kind: "Skill", name: skill.name })) return;
  await operatorApi(`/api/skills/registry/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
  await skillRegistryFeature.loadRegistry({ keepSelection: false, refresh: true });
}

function configureTagEditor(prefix) {
  const presetId = prefix === "new" ? "new-skill-tag-presets" : "edit-skill-tag-presets";
  const selectedId = prefix === "new" ? "new-skill-selected-tags" : "edit-skill-selected-tags";
  const inputId = prefix === "new" ? "new-skill-tag-input" : "edit-skill-tag-input";
  const addId = prefix === "new" ? "new-skill-tag-add-btn" : "edit-skill-tag-add-btn";
  $(presetId).addEventListener("click", (event) => {
    const button = event.target.closest("[data-tag]");
    if (!button) return;
    const tags = selected[prefix];
    tags.has(button.dataset.tag) ? tags.delete(button.dataset.tag) : tags.add(button.dataset.tag);
    renderTags(prefix);
  });
  $(selectedId).addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-tag]");
    if (!button) return;
    selected[prefix].delete(button.dataset.removeTag);
    renderTags(prefix);
  });
  const add = () => {
    const input = $(inputId);
    input.value.toLowerCase().split(/[,，\s]+/).filter(Boolean).forEach((tag) => selected[prefix].add(tag));
    input.value = "";
    renderTags(prefix);
  };
  $(addId).addEventListener("click", add);
  $(inputId).addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); add(); }
  });
}

function renderTags(prefix) {
  const known = new Set(PRESET_TAGS);
  skillRegistryFeature.list().forEach((skill) => (skill.tags ?? []).forEach((tag) => known.add(tag)));
  const presetId = prefix === "new" ? "new-skill-tag-presets" : "edit-skill-tag-presets";
  const selectedId = prefix === "new" ? "new-skill-selected-tags" : "edit-skill-selected-tags";
  $(presetId).innerHTML = [...known].sort().map((tag) => `<button type="button" class="skill-tag-preset-btn ${selected[prefix].has(tag) ? "selected" : ""}" data-tag="${escapeHtml(tag)}">${selected[prefix].has(tag) ? "✓ " : "+"}${escapeHtml(tag)}</button>`).join("");
  $(selectedId).innerHTML = selected[prefix].size
    ? [...selected[prefix]].map((tag) => `<span class="skill-tag-chip">#${escapeHtml(tag)}<button type="button" data-remove-tag="${escapeHtml(tag)}" title="移除标签">×</button></span>`).join("")
    : '<span class="muted">未选择标签</span>';
}

function ensureOperator() {
  if (operatorSession.authenticated) return true;
  openOperatorDialog();
  return false;
}

function updateSkillUrl(id) {
  if (!skillsRoute) return;
  const url = new URL(location.href);
  url.searchParams.set("skill", id);
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function setStatus(id, message, error = false) {
  $(id).className = `operator-login-status${error ? " error" : ""}`;
  $(id).textContent = message;
}
