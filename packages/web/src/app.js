const $ = (id) => document.getElementById(id);
const phases = { queued: 8, planning: 25, executing: 55, reviewing: 78, repairing: 68, cancelling: 85, cancelled: 100, completed: 100, failed: 100 };
let tribe;
let status;
let settlement;
let activeJobId;
let activeDevelopmentProposal;

$("operator-token").value = localStorage.getItem("totemora_operator_token") || "";
$("operator-token").addEventListener("change", () => {
  localStorage.setItem("totemora_operator_token", $("operator-token").value);
  void loadDevelopmentHistory();
});

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
  await loadEmbers();
  $("chief").innerHTML = tribe.members.filter((m) => m.roles.includes("chief") && !["inactive", "retired"].includes(m.status))
    .map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === tribe.tribe.chief ? "selected" : ""}>${escapeHtml(m.name)} · ${escapeHtml(m.model)}</option>`).join("");
  await loadHistory();
  await loadSettlement();
  await loadDevelopmentHistory();
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
  const members = tribe.members.filter((member) => !["inactive", "retired"].includes(member.status)).slice(0, 3);
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
    const workplace = await api("/api/workplaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("workplace-name").value, path: $("workplace-path").value }) });
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
  if (!$("operator-token").value.trim()) return;
  try {
    const { proposals } = await operatorApi("/api/development/proposals", { method: "GET" });
    $("development-history").innerHTML = proposals.slice(0, 6).map((proposal) => `<article>
      <p>${escapeHtml(proposal.commit_message)}</p><small>${escapeHtml(proposal.status)} · ${new Date(proposal.created_at).toLocaleString()}</small>
      <button type="button" class="secondary proposal-open" data-id="${escapeHtml(proposal.id)}">查看</button>
    </article>`).join("") || "<small>还没有开发提交 Proposal</small>";
    document.querySelectorAll(".proposal-open").forEach((button) => button.addEventListener("click", async () => {
      const proposal = await operatorApi(`/api/development/proposals/${button.dataset.id}`, { method: "GET" });
      activeDevelopmentProposal = proposal.id;
      $("run-panel").classList.remove("hidden");
      renderDevelopmentProposal(proposal);
    }));
    const skillData = await operatorApi("/api/development/skill-proposals", { method: "GET" });
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
    const job = await api("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
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
  $("run-message").textContent = "Chief 正在委派开发提交专员，随后由 Reviewer 复核";
  $("progress-bar").style.width = "45%";
  const proposal = await operatorApi("/api/development/prepare", {
    method: "POST",
    body: JSON.stringify({ workplace_id: $("workplace").value, goal: $("goal").value }),
  });
  activeDevelopmentProposal = proposal.id;
  renderDevelopmentProposal(proposal);
  await loadDevelopmentHistory();
}

function renderDevelopmentProposal(proposal) {
  $("phase").textContent = proposal.status.toUpperCase();
  $("progress-bar").style.width = proposal.status === "completed" ? "100%" : "70%";
  $("development-proposal").innerHTML = `<article class="proposal">
    <h3>开发提交 Proposal</h3>
    <p>${escapeHtml(proposal.summary)}</p>
    <p><b>${escapeHtml(proposal.commit_message)}</b></p>
    <div class="chips">Chief / ${escapeHtml(proposal.chief_member_id)} → 专员 / ${escapeHtml(proposal.specialist_member_id)} → Reviewer / ${escapeHtml(proposal.reviewer_member_id)}</div>
    <p>派工理由：${escapeHtml(proposal.assignment_reason)}</p>
    <p>风险：${escapeHtml(proposal.risk)}</p>
    <p>文件：</p><ul>${proposal.files.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>
    <p>批准后验证：</p><ul>${proposal.validation_commands.map((command) => `<li>${escapeHtml(command)}</li>`).join("") || "<li>无验证命令</li>"}</ul>
    <p class="${proposal.review.outcome === "accepted" ? "approved" : "error"}">独立复核：${escapeHtml(proposal.review.outcome)} · ${escapeHtml(proposal.review.rationale)}</p>
    ${proposal.status === "awaiting_approval" && proposal.review.outcome === "accepted" ? '<button id="approve-development" type="button">批准验证并提交</button>' : ""}
    ${proposal.validation_results ? `<pre>${escapeHtml(JSON.stringify(proposal.validation_results, null, 2))}</pre>` : ""}
    ${proposal.commit_sha ? `<p class="approved">Commit: ${escapeHtml(proposal.commit_sha)}</p>` : ""}
    ${proposal.error ? `<p class="error">${escapeHtml(proposal.error)}</p>` : ""}
  </article>`;
  $("approve-development")?.addEventListener("click", approveDevelopmentCommit);
}

async function approveDevelopmentCommit() {
  if (!activeDevelopmentProposal) return;
  $("approve-development").disabled = true;
  $("phase").textContent = "EXECUTING";
  $("run-message").textContent = "正在验证批准快照并创建提交";
  const proposal = await operatorApi(`/api/development/proposals/${activeDevelopmentProposal}/approve`, { method: "POST" });
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
  try { await api(`/api/runs/${activeJobId}/cancel`, { method: "POST" }); }
  catch (error) { renderError(error.message); }
});

$("retry-run").addEventListener("click", async () => {
  if (!activeJobId) return;
  $("retry-run").disabled = true;
  try {
    const job = await api(`/api/runs/${activeJobId}/retry`, { method: "POST" });
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
async function api(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
async function operatorApi(url, options = {}) {
  const token = $("operator-token").value.trim();
  if (!token) throw new Error("请输入操作员 Token");
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}`, ...(options.headers || {}) };
  return api(url, { ...options, headers });
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", "\"":"&quot;" })[char]); }

loadTribe().then(analyzeIntake).catch((error) => { $("tribe-status").textContent = error.message; $("tribe-status").classList.add("error"); });
