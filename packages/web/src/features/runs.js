import { phases } from "../shared/app-context.js";
import { $, escapeHtml } from "../shared/dom.js";
import { api, operatorApi } from "../shared/operator-session.js";

let activeJobId;
let onSettled = async () => {};

$("cancel-run").addEventListener("click", cancelRun);
$("retry-run").addEventListener("click", retryRun);

export const runsFeature = {
  configure(options) {
    onSettled = options.onSettled;
  },
  async start(jobId) {
    activeJobId = jobId;
    $("cancel-run").classList.remove("hidden");
    await watchRun(jobId);
  },
  explainFailure,
  renderError,
};

async function watchRun(id) {
  for (;;) {
    const job = await api(`/api/runs/${id}`);
    $("phase").textContent = job.phase.toUpperCase();
    $("run-message").textContent = job.message;
    $("progress-bar").style.width = `${phases[job.phase] ?? 12}%`;
    renderActivity(job);
    if (job.run?.plan) renderStaffing(job.run);
    if (job.status === "completed") {
      finishWatching();
      renderReport(job.run);
      await onSettled();
      return;
    }
    if (job.status === "failed") {
      finishWatching();
      renderError(explainFailure(job.error));
      if (job.failure?.retryable) {
        activeJobId = job.id;
        $("retry-run").classList.remove("hidden");
      }
      await onSettled();
      return;
    }
    if (job.status === "cancelled") {
      finishWatching();
      renderError("Run 已取消");
      await onSettled();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function cancelRun() {
  if (!activeJobId) return;
  $("cancel-run").disabled = true;
  try {
    await operatorApi(`/api/runs/${activeJobId}/cancel`, { method: "POST" });
  } catch (error) {
    renderError(error.message);
  }
}

async function retryRun() {
  if (!activeJobId) return;
  $("retry-run").disabled = true;
  try {
    const job = await operatorApi(`/api/runs/${activeJobId}/retry`, { method: "POST" });
    $("retry-run").classList.add("hidden");
    activeJobId = job.id;
    $("cancel-run").classList.remove("hidden");
    await watchRun(job.id);
  } catch (error) {
    renderError(error.message);
  } finally {
    $("retry-run").disabled = false;
  }
}

function finishWatching() {
  activeJobId = undefined;
  $("cancel-run").classList.add("hidden");
  $("cancel-run").disabled = false;
  $("retry-run").classList.add("hidden");
}

function renderActivity(job) {
  const started = new Date(job.created_at).getTime();
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  $("activity").innerHTML = `<div><time>${elapsed}s</time>本次 Run 已持续；模型调用期间可能数十秒无新事件</div>`
    + (job.activities || []).map((item) => `<div><time>+${Math.round((new Date(item.at).getTime() - started) / 1000)}s</time>${escapeHtml(item.phase)} · ${escapeHtml(item.message)}</div>`).join("");
}

function renderStaffing(run) {
  $("staffing").innerHTML = `<h3>首领派工</h3>${run.plan.assignments.map((item) => `
    <article class="assignment"><b>${escapeHtml(item.member_id)}</b> · ${escapeHtml(item.role)}
      <div>${escapeHtml(item.instruction)}</div><small>为何选择：${escapeHtml(item.assignment_reason)}</small>
      <div class="chips">依据 / ${item.selection_factors.map(escapeHtml).join(" · ")} 　Skills / ${item.skills.map(escapeHtml).join(" · ") || "无"}</div>
      <div class="chips">能力匹配分 / ${item.selection_score ?? "待评估"} 　成本效率先验 / ${item.cost_efficiency ?? "待评估"}</div>
    </article>`).join("")}
    <details><summary>查看全部候选排序</summary>${(run.plan.candidate_ranking || []).map((item, index) => `<div class="profile-row"><span>${index + 1}. ${escapeHtml(item.member_id)}${item.selected ? " ✓" : ""}</span><i><b style="width:${Math.round(item.score * 100)}%"></b></i><em>${item.score}</em></div><div class="chips">能力 ${item.capability_match} · 历史 ${item.historical_acceptance ?? "无样本"} · 成本 ${item.cost_efficiency}</div>`).join("")}</details>`;
}

function renderReport(run) {
  const report = run.final_report;
  $("report").innerHTML = `<h3>${escapeHtml(report.title)}</h3><p>${escapeHtml(report.summary)}</p>
    <div class="metrics"><span>${run.review_outcome}</span><span>${run.usage?.calls ?? 0} 次调用</span><span>${run.usage?.total_tokens ?? 0} Tokens</span></div>
    ${report.findings.map((finding) => `<article class="finding"><b>${escapeHtml(finding.claim)}</b><div class="chips">${finding.evidence.map(escapeHtml).join("<br>")}</div></article>`).join("")}
    <h3>建议</h3>${report.recommendations.map((recommendation) => `<p><b>[${escapeHtml(recommendation.priority)}] ${escapeHtml(recommendation.action)}</b><br><small>${escapeHtml(recommendation.reason)}</small></p>`).join("")}
    <h3>验收</h3>${report.acceptance_review.map((review) => `<p><b>${escapeHtml(review.status)}</b> · ${escapeHtml(review.criterion)}<br><small>${escapeHtml(review.evidence)}</small></p>`).join("")}`;
  if (run.independent_review) {
    $("report").innerHTML += `<h3>独立 Reviewer</h3><article class="finding"><b>${escapeHtml(run.independent_review.reviewer_member_id)} · ${escapeHtml(run.independent_review.outcome)}</b><p>${escapeHtml(run.independent_review.rationale)}</p><div class="chips">${run.independent_review.issues.map(escapeHtml).join(" · ") || "未发现额外问题"}</div></article>`;
  }
  $("trace").textContent = JSON.stringify(run, null, 2);
  $("trace-wrap").classList.remove("hidden");
}

function renderError(message) {
  $("phase").textContent = "FAILED";
  $("run-message").innerHTML = `<span class="error">${escapeHtml(message || "未知错误")}</span>`;
}

function explainFailure(message = "") {
  return message.includes("stop_reason=max_tokens") || message.includes("returned no text content")
    ? `${message}。模型输出预算可能耗尽；DeepSeek 建议至少 6000 Token 后重试。`
    : message;
}
