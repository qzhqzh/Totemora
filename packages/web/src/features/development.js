import { $, copyText, escapeHtml } from "../shared/dom.js";
import { api, operatorApi, operatorSession } from "../shared/operator-session.js";
import { runsFeature } from "./runs.js";
import { workplacesFeature } from "./workplaces.js";

let activeProposalId;
let activeTaskId;

$("task-form").addEventListener("submit", handleTaskSubmit);

export const developmentFeature = {
  analyzeIntake: workplacesFeature.analyzeIntake,
  loadDevelopmentHistory,
  loadHistory,
  loadSettlement: workplacesFeature.loadSettlement,
  refreshProtected() {
    void loadDevelopmentHistory();
  },
  lockProtected: clearProtectedUi,
};

async function loadHistory() {
  const { jobs } = await api("/api/jobs");
  $("history").innerHTML = jobs.length ? jobs.slice(0, 8).map((job) => `<article>
    <p>${escapeHtml(job.goal || "未命名任务")}</p><small>${escapeHtml(job.status)} / ${escapeHtml(job.phase)}${job.failure ? ` / ${escapeHtml(job.failure.category)} / ${job.failure.retryable ? "可重试" : "需处理"}` : ""} · ${new Date(job.created_at).toLocaleString()}${job.error ? ` · ${escapeHtml(runsFeature.explainFailure(job.error))}` : ""}</small>
  </article>`).join("") : "<small>还没有任务记录</small>";
}

async function loadDevelopmentHistory() {
  if (!operatorSession.authenticated) {
    clearProtectedUi();
    return;
  }
  try {
    const [{ proposals }, taskData, skillData] = await Promise.all([
      operatorApi("/api/development/proposals", { method: "GET" }),
      operatorApi("/api/development/tasks", { method: "GET" }),
      operatorApi("/api/development/skill-proposals", { method: "GET" }),
    ]);
    const tasks = Array.isArray(taskData) ? taskData : taskData.tasks || [];
    const unresolvedTasks = tasks.filter((task) =>
      ["queued", "running", "failed"].includes(task.status) && !task.proposal_id && !task.result?.id);
    const history = [
      ...unresolvedTasks.map((task) => ({ kind: "task", at: task.updated_at || task.created_at, value: task })),
      ...proposals.map((proposal) => ({ kind: "proposal", at: proposal.updated_at || proposal.created_at, value: proposal })),
    ].sort((left, right) => String(right.at).localeCompare(String(left.at))).slice(0, 8);
    $("development-history").innerHTML = history.map((entry) => entry.kind === "task"
      ? renderTaskHistory(entry.value)
      : renderProposalHistory(entry.value)).join("") || "<small>还没有开发专业任务</small>";
    document.querySelectorAll(".proposal-open").forEach((button) => button.addEventListener("click", async () => {
      const proposal = await operatorApi(`/api/development/proposals/${button.dataset.id}`, { method: "GET" });
      activeTaskId = undefined;
      activeProposalId = proposal.id;
      $("run-panel").classList.remove("hidden");
      renderProposal(proposal);
    }));
    document.querySelectorAll(".evidence-copy").forEach((button) => button.addEventListener("click", async () => {
      await copyText(button.dataset.evidenceId);
      button.textContent = "已复制";
    }));
    document.querySelectorAll("[data-development-task-check]").forEach((button) => button.addEventListener("click", async () => {
      const statusNode = button.closest("article")?.querySelector("[data-development-task-status]");
      await checkTask(button.dataset.developmentTaskCheck, button, statusNode);
    }));
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

function renderProposalHistory(proposal) {
  return `<article>
    <p>${escapeHtml(proposal.commit_message)}</p><small>${escapeHtml(proposal.status)} · ${new Date(proposal.created_at).toLocaleString()} · 证据 ID <code>${escapeHtml(proposal.id)}</code>${proposal.skill?.commission_id ? ` · 试用案卷 <code>${escapeHtml(proposal.skill.commission_id)}</code>` : " · 当前能力基线"}</small>
    <div class="history-actions"><button type="button" class="secondary proposal-open" data-id="${escapeHtml(proposal.id)}">查看</button><button type="button" class="secondary evidence-copy" data-evidence-id="${escapeHtml(proposal.id)}">复制证据 ID</button></div>
  </article>`;
}

function renderTaskHistory(task) {
  const status = task.status === "failed" ? "失败" : task.status === "running" ? "执行中" : "排队中";
  return `<article data-development-task="${escapeHtml(task.id)}">
    <p>${escapeHtml(task.goal || "未命名 Git 专业任务")}</p>
    <small data-development-task-status class="${task.status === "failed" ? "error" : ""}">${status} · 后台任务 ID <code>${escapeHtml(task.id)}</code> · ${new Date(task.updated_at || task.created_at).toLocaleString()}${task.error ? ` · ${escapeHtml(task.error)}` : ""}</small>
    <div class="history-actions"><button type="button" class="secondary" data-development-task-check="${escapeHtml(task.id)}">检查结果</button></div>
  </article>`;
}

function clearProtectedUi() {
  const hadDevelopmentSurface = Boolean(activeProposalId || activeTaskId || $("development-proposal").textContent.trim());
  activeProposalId = undefined;
  activeTaskId = undefined;
  $("development-history").innerHTML = "<small>输入操作员 Token 后显示开发专业任务。</small>";
  $("skill-proposal-history").innerHTML = "<small>输入操作员 Token 后显示 Skill 改进提案。</small>";
  $("development-proposal").innerHTML = "";
  if (hadDevelopmentSurface) {
    $("phase").textContent = "LOCKED";
    $("run-message").textContent = "开发任务证据已锁定；输入操作员 Token 后可重新查看";
    $("progress-bar").style.width = "0%";
  }
}

async function handleTaskSubmit(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $("run-panel").classList.remove("hidden");
  $("staffing").innerHTML = "";
  $("report").innerHTML = "";
  $("development-proposal").innerHTML = "";
  $("trace-wrap").classList.add("hidden");
  try {
    const analysis = await workplacesFeature.analyzeIntake();
    if (analysis.type === "change") {
      await prepareCommit();
      return;
    }
    if (!analysis.execution_enabled) throw new Error(`任务模式 ${analysis.type} 尚未开放执行：${analysis.reason}`);
    const job = await operatorApi("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        goal: $("goal").value,
        workspace: $("workspace").value,
        workplace_id: $("workplace").value,
        mission_id: $("mission").value,
        chief: $("chief").value,
        acceptance: $("acceptance").value.split("\n").map((value) => value.trim()).filter(Boolean),
        max_members: numberValue("max-members"),
        max_total_tokens: numberValue("max-total-tokens"),
        max_files: numberValue("max-files"),
        max_context_bytes: numberValue("max-context"),
        max_output_tokens: numberValue("max-output"),
      }),
    });
    await runsFeature.start(job.id);
  } catch (error) {
    runsFeature.renderError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function prepareCommit() {
  if (!$("workplace").value) throw new Error("开发提交必须选择已登记工作地");
  $("phase").textContent = "PLANNING";
  $("run-message").textContent = "Chief 正在把目标路由给 Git 流程专员，并验收其计划";
  $("progress-bar").style.width = "45%";
  const task = await operatorApi("/api/development/tasks", {
    method: "POST",
    body: JSON.stringify({
      workplace_id: $("workplace").value,
      goal: $("goal").value,
      mode: $("git-flow-mode").value,
      issue_mode: $("git-flow-mode").value === "commit" ? "none" : "auto",
      trial_commission_id: $("trial-commission-id").value.trim() || undefined,
    }),
  });
  activeTaskId = task.id;
  const proposal = await waitForTask(task.id);
  if (!proposal) {
    renderDeferredTask(task.id);
    await loadDevelopmentHistory();
    return;
  }
  activeTaskId = undefined;
  activeProposalId = proposal.id;
  renderProposal(proposal);
  await loadDevelopmentHistory();
}

async function waitForTask(taskId) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const task = await operatorApi(`/api/development/tasks/${encodeURIComponent(taskId)}`);
    $("run-message").textContent = task.status === "running"
      ? "Git 专员正在检查工作树，Chief 将独立验收"
      : `专业任务 ${task.status}`;
    if (task.status === "completed" && task.result) return task.result;
    if (task.status === "failed") {
      activeTaskId = undefined;
      await loadDevelopmentHistory();
      throw new Error(task.error || "Git 专业任务失败");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

function renderDeferredTask(taskId) {
  $("phase").textContent = "RUNNING";
  $("run-message").textContent = "Git 专业任务仍在后台运行，可随时检查，不会因页面停止等待而丢失";
  $("development-proposal").innerHTML = `<article class="proposal" data-deferred-development-task="${escapeHtml(taskId)}">
    <h3>Git 专业任务已转入后台</h3>
    <p>前台等待已到 90 秒上限；任务仍由部落继续执行。</p>
    <div class="proposal-evidence"><span>后台任务 ID</span><code>${escapeHtml(taskId)}</code><button type="button" class="secondary" data-copy-development-task>复制</button></div>
    <button type="button" data-development-task-check="${escapeHtml(taskId)}">检查结果</button>
    <small data-development-task-status class="form-status" role="status" aria-live="polite">尚未再次检查</small>
  </article>`;
  const card = $("development-proposal").querySelector("[data-deferred-development-task]");
  card.querySelector("[data-copy-development-task]").addEventListener("click", async (event) => {
    await copyText(taskId);
    event.currentTarget.textContent = "已复制";
  });
  const button = card.querySelector("[data-development-task-check]");
  button.addEventListener("click", () => void checkTask(taskId, button, card.querySelector("[data-development-task-status]")));
}

async function checkTask(taskId, button, statusNode) {
  button.disabled = true;
  if (statusNode) {
    statusNode.classList.remove("error");
    statusNode.textContent = "正在检查后台任务…";
  }
  try {
    const task = await operatorApi(`/api/development/tasks/${encodeURIComponent(taskId)}`);
    if (task.status === "completed" && task.result) {
      activeTaskId = undefined;
      activeProposalId = task.result.id;
      $("run-panel").classList.remove("hidden");
      renderProposal(task.result);
      await loadDevelopmentHistory();
      return;
    }
    if (task.status === "failed") {
      if (statusNode) {
        statusNode.classList.add("error");
        statusNode.textContent = `后台任务失败：${task.error || "未知错误"}`;
      }
      await loadDevelopmentHistory();
      return;
    }
    if (statusNode) statusNode.textContent = `后台任务仍在${task.status === "queued" ? "排队" : "执行"}，稍后可再次检查`;
  } catch (error) {
    if (statusNode) {
      statusNode.classList.add("error");
      statusNode.textContent = `检查失败：${error.message}`;
    }
  } finally {
    button.disabled = false;
  }
}

function renderProposal(proposal) {
  $("phase").textContent = proposal.status.toUpperCase();
  $("progress-bar").style.width = proposal.status === "completed" ? "100%" : "70%";
  $("development-proposal").innerHTML = `<article class="proposal">
    <h3>Git Flow 工作流</h3>
    <p>${escapeHtml(proposal.summary)}</p>
    <p><b>${escapeHtml(proposal.commit_message)}</b></p>
    <div class="chips">Chief / ${escapeHtml(proposal.chief_member_id)} → Git流程专员 / ${escapeHtml(proposal.specialist_member_id)} → Chief 验收</div>
    <div class="proposal-evidence"><span>试炼证据 ID</span><code>${escapeHtml(proposal.id)}</code><button type="button" class="secondary" data-copy-proposal-evidence>复制</button></div>
    <p class="chips">Skill v${proposal.skill.version} · ${proposal.skill.commission_id ? `隔离试用案卷 <code>${escapeHtml(proposal.skill.commission_id)}</code>` : "当前活动能力基线"} · 加载 digest <code>${escapeHtml(proposal.skill.digest || "未记录")}</code>${proposal.skill.package_digest ? ` · 包 digest <code>${escapeHtml(proposal.skill.package_digest)}</code>` : ""}</p>
    <p class="chips">本次评测：${escapeHtml(proposal.evaluation?.usage_status || "unknown")} · ${proposal.evaluation?.total_tokens ?? 0} Tokens · ${proposal.evaluation?.latency_ms ?? 0} ms</p>
    <p>派工理由：${escapeHtml(proposal.assignment_reason)}</p>
    <p>风险：${escapeHtml(proposal.risk)}</p>
    <p>文件：</p><ul>${proposal.files.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>
    <p>批准后验证：</p><ul>${proposal.validation_commands.map((command) => `<li>${escapeHtml(command)}</li>`).join("") || "<li>无验证命令</li>"}</ul>
    <p class="${proposal.self_check.outcome === "accepted" ? "approved" : "error"}">专员自检：${escapeHtml(proposal.self_check.outcome)} · ${escapeHtml(proposal.self_check.rationale)}</p>
    <p class="${proposal.chief_acceptance.outcome === "accepted" ? "approved" : "error"}">Chief 验收：${escapeHtml(proposal.chief_acceptance.outcome)} · ${escapeHtml(proposal.chief_acceptance.rationale)}</p>
    ${proposal.status === "awaiting_approval" ? '<button class="advance-development" data-gate="local" type="button">批准验证并提交</button>' : ""}
    ${proposal.status === "awaiting_remote_approval" ? '<button class="advance-development" data-gate="remote" type="button">批准创建 Issue、Push 和 PR</button>' : ""}
    ${proposal.status === "awaiting_merge_approval" ? '<button class="advance-development" data-gate="merge" type="button">批准 Merge</button>' : ""}
    ${proposal.validation_results ? `<pre>${escapeHtml(JSON.stringify(proposal.validation_results, null, 2))}</pre>` : ""}
    ${proposal.commit_sha ? `<p class="approved">Commit: ${escapeHtml(proposal.commit_sha)}</p>` : ""}
    ${proposal.issue_url ? `<p>Issue: <a href="${escapeHtml(proposal.issue_url)}" target="_blank">${escapeHtml(proposal.issue_url)}</a></p>` : ""}
    ${proposal.pr_url ? `<p>PR: <a href="${escapeHtml(proposal.pr_url)}" target="_blank">${escapeHtml(proposal.pr_url)}</a></p>` : ""}
    ${proposal.error ? `<p class="error">${escapeHtml(proposal.error)}</p>` : ""}
  </article>`;
  document.querySelectorAll(".advance-development").forEach((button) => button.addEventListener("click", () => advanceDevelopment(button.dataset.gate)));
  document.querySelector("[data-copy-proposal-evidence]")?.addEventListener("click", async (event) => {
    await copyText(proposal.id);
    event.currentTarget.textContent = "已复制";
  });
}

async function advanceDevelopment(gate) {
  if (!activeProposalId) return;
  $("phase").textContent = "EXECUTING";
  $("run-message").textContent = `正在推进 ${gate} 门禁`;
  const proposal = await operatorApi(`/api/development/proposals/${activeProposalId}/advance`, {
    method: "POST",
    body: JSON.stringify({ gate }),
  });
  renderProposal(proposal);
  await loadDevelopmentHistory();
  await workplacesFeature.loadSettlement();
}

function numberValue(id) {
  const value = Number($(id).value);
  return Number.isFinite(value) ? value : undefined;
}
