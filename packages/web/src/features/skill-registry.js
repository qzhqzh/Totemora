import { skillsRoute } from "../shared/app-context.js";
import { $, escapeHtml, formatObservatoryTime } from "../shared/dom.js";
import { api, openOperatorDialog, operatorApi, operatorSession } from "../shared/operator-session.js";
import { skillCommissionsFeature } from "./skill-commissions.js";
import {
  fileKindLabel,
  formatFileSize,
  memberLabel,
  registryStatusLabel,
  skillStatusLabel,
  validationStatusLabel,
} from "./skill-formatters.js";

let registrySkills = [];
let activeRegistrySkillId;
let activeRegistryFilePath;
let activeTag = "all";

$("refresh-skill-registry").addEventListener("click", () => void loadRegistry({ keepSelection: true, refresh: true }));
$("skill-registry-list").addEventListener("click", handleRegistrySelection);
$("skill-registry-detail").addEventListener("click", handleRegistryDetailClick);
$("skill-tag-filter-bar").addEventListener("click", (event) => {
  const button = event.target.closest("[data-skill-filter-tag]");
  if (!button) return;
  activeTag = button.dataset.skillFilterTag;
  renderTagFilter();
  renderRegistryList();
});

export const skillRegistryFeature = {
  loadRegistry,
  list: () => registrySkills,
  select(id, filePath) {
    activeRegistrySkillId = id;
    activeRegistryFilePath = filePath;
    renderRegistryList();
    renderRegistryDetail(registrySkills.find((skill) => skill.id === id));
  },
  refreshSelected,
  refreshProtected: refreshSelected,
  lockProtected: refreshSelected,
};

async function loadRegistry({ keepSelection = true, refresh = false } = {}) {
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
    renderRegistrySummary(registrySkills);
    renderTagFilter();
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
      renderRegistryList();
      renderRegistryDetail(selected);
    }
    live.textContent = `${registrySkills.length} 个 Skill · 扫描于 ${formatObservatoryTime(result.scanned_at)}`;
  } catch (error) {
    registrySkills = [];
    activeRegistrySkillId = undefined;
    $("skill-registry-summary").innerHTML = "";
    renderTagFilter();
    list.innerHTML = `<div class="skill-registry-placeholder"><h3>技能库读取失败</h3><p>${escapeHtml(error.message)}</p></div>`;
    detail.innerHTML = '<div class="skill-registry-placeholder"><h3>无法显示详情</h3><p>请检查 Gateway 和仓库 skills/ 目录后重新扫描。</p></div>';
    live.classList.add("error");
    live.textContent = `扫描失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function refreshSelected() {
  if (activeRegistrySkillId) renderRegistryDetail(registrySkills.find((skill) => skill.id === activeRegistrySkillId));
}

function renderRegistrySummary(skills) {
  const counts = { active: 0, candidate: 0, warning: 0, invalid: 0 };
  for (const skill of skills) counts[skill.status] = (counts[skill.status] || 0) + 1;
  $("skill-registry-summary").innerHTML = [
    ["已装备", counts.active, "活动版本或仓库声明"],
    ["候选", counts.candidate, "结构校验通过"],
    ["需关注", counts.warning, "存在非阻断警告"],
    ["不可用", counts.invalid, "Doctor 阻断"],
  ].map(([label, value, note]) => `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
}

function renderRegistryList() {
  const filtered = activeTag === "all"
    ? registrySkills
    : registrySkills.filter((skill) => (skill.tags ?? []).includes(activeTag));
  if (!filtered.length) {
    $("skill-registry-list").innerHTML = `<p class="skill-empty">没有标签为 #${escapeHtml(activeTag)} 的 Skill。</p>`;
    return;
  }
  $("skill-registry-list").innerHTML = filtered.map((skill) => `<button type="button" class="skill-registry-item" data-registry-skill="${escapeHtml(skill.id)}" aria-pressed="${skill.id === activeRegistrySkillId}">
    <span><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(skill.id)} · ${escapeHtml(skill.version ? `v${skill.version}` : skill.hash_short)}</small>
      ${(skill.tags ?? []).length ? `<span class="skill-tag-list">${skill.tags.map((tag) => `<span class="skill-tag-badge">#${escapeHtml(tag)}</span>`).join("")}</span>` : ""}<em>查看详情</em></span>
    <span class="skill-registry-state ${escapeHtml(skill.status)}">${escapeHtml(registryStatusLabel(skill.status))}</span>
  </button>`).join("");
}

function renderTagFilter() {
  const tags = new Set(registrySkills.flatMap((skill) => skill.tags ?? []));
  if (activeTag !== "all" && !tags.has(activeTag)) activeTag = "all";
  $("skill-tag-filter-bar").innerHTML = ["all", ...tags].sort((left, right) => {
    if (left === "all") return -1;
    if (right === "all") return 1;
    return left.localeCompare(right);
  }).map((tag) => `<button type="button" class="skill-tag-filter-pill ${tag === activeTag ? "active" : ""}" data-skill-filter-tag="${escapeHtml(tag)}">${tag === "all" ? "全部" : `#${escapeHtml(tag)}`}</button>`).join("");
}

function renderRegistryDetail(skill) {
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
  const files = renderFileBrowser(skill);
  const commission = skill.governance.latest_commission;
  const activation = skill.governance.activation;
  const trials = skill.governance.trials;
  const activationDetail = activation
    ? `${escapeHtml(activation.status)} · v${activation.version}<br><code>${escapeHtml(activation.digest.slice(0, 12))}</code>`
    : skill.status === "active" ? `仓库声明 · ${skill.version ? `v${skill.version}` : skill.hash_short}` : "尚未激活";
  detail.innerHTML = `<div class="skill-detail-head">
    <div><h3>${escapeHtml(skill.name)}</h3><p>${escapeHtml(skill.description)}</p><small><code>${escapeHtml(skill.id)}</code> · ${skill.version ? `v${skill.version}` : escapeHtml(skill.hash_short)}</small></div>
    <div class="skill-detail-actions"><button type="button" class="secondary" data-edit-skill="${escapeHtml(skill.id)}">编辑</button><button type="button" class="secondary destructive" data-delete-skill="${escapeHtml(skill.id)}">删除</button><span class="skill-registry-state ${escapeHtml(skill.status)}">${escapeHtml(registryStatusLabel(skill.status))}</span></div>
  </div>
  <div class="skill-detail-section skill-package-primary"><h4>Skill 包</h4><p class="skill-section-note">浏览仓库中的完整目录；文本内容需要操作员 Token，只读且不会执行脚本。</p>${files}</div>
  <dl class="skill-detail-meta">
    <div><dt>Skill ID</dt><dd><code>${escapeHtml(skill.id)}</code></dd></div>
    <div><dt>标签</dt><dd>${(skill.tags ?? []).length ? skill.tags.map((tag) => `<span class="skill-tag-badge">#${escapeHtml(tag)}</span>`).join(" ") : "未打标"}</dd></div>
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

  if (activeRegistryFilePath) void loadFilePreview(skill.id, activeRegistryFilePath, { interactive: false });
}

function renderFileBrowser(skill) {
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
    <nav class="skill-file-tree" aria-label="${escapeHtml(skill.name)} 文件目录">${renderTreeNode(tree)}</nav>
    <section id="skill-file-preview" class="skill-file-preview" aria-live="polite">
      <div class="skill-file-preview-empty"><strong>选择文件查看内容</strong><p>${operatorSession.authenticated ? "可预览 SKILL.md、配置、脚本和参考文本；资产与敏感文件只显示目录信息。" : "先从页面右上角完成操作员登录，再选择文本文件。"}</p></div>
    </section>
  </div>`;
}

function renderTreeNode(node) {
  const directories = [...node.directories.entries()].sort(([left], [right]) => left.localeCompare(right));
  const files = [...node.files].sort((left, right) => left.path.localeCompare(right.path));
  return `<ul>${directories.map(([name, child]) => `<li class="skill-directory"><span><b>目录</b>${escapeHtml(name)}</span>${renderTreeNode(child)}</li>`).join("")}${files.map((file) => `<li><button type="button" data-skill-file="${escapeHtml(file.path)}" aria-pressed="${file.path === activeRegistryFilePath}"><b>${escapeHtml(fileKindLabel(file.kind))}</b><span>${escapeHtml(file.path.split("/").at(-1))}</span><small>${formatFileSize(file.size)}</small></button></li>`).join("")}</ul>`;
}

async function loadFilePreview(skillId, filePath, { interactive = false } = {}) {
  const preview = $("skill-file-preview");
  if (!preview) return;
  activeRegistryFilePath = filePath;
  document.querySelectorAll("[data-skill-file]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.skillFile === filePath)));
  if (!operatorSession.authenticated) {
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
    if (interactive && !operatorSession.authenticated) openOperatorDialog();
  }
}

function handleRegistrySelection(event) {
  const button = event.target.closest("[data-registry-skill]");
  if (!button) return;
  activeRegistrySkillId = button.dataset.registrySkill;
  const selected = registrySkills.find((skill) => skill.id === activeRegistrySkillId);
  const defaultFile = selected?.files.find((file) => file.path === "SKILL.md") || selected?.files[0];
  activeRegistryFilePath = defaultFile?.path;
  renderRegistryList();
  renderRegistryDetail(selected);
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
}

async function handleRegistryDetailClick(event) {
  const file = event.target.closest("[data-skill-file]");
  if (file) {
    await loadFilePreview(activeRegistrySkillId, file.dataset.skillFile, { interactive: true });
    return;
  }
  const link = event.target.closest("[data-open-skill-commission]");
  if (!link) return;
  if (!operatorSession.authenticated) {
    event.preventDefault();
    $("skill-registry-live").classList.add("error");
    $("skill-registry-live").textContent = "输入操作员 Token 后才能查看委任和试炼证据";
    openOperatorDialog();
    return;
  }
  await skillCommissionsFeature.loadCommissions();
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-commission-id="${CSS.escape(link.dataset.openSkillCommission)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    card.setAttribute("tabindex", "-1");
    card.focus({ preventScroll: true });
  });
}
