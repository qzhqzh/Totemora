import { state } from "../shared/app-context.js";
import { $, escapeHtml, formatObservatoryTime } from "../shared/dom.js";
import { operatorApi, operatorSession } from "../shared/operator-session.js";
import { memberLabel, skillStatusLabel, trialStageLabel } from "./skill-formatters.js";

let trialRuns = [];
let commissions = [];

$("refresh-skills").addEventListener("click", () => void loadCommissions());
$("skill-commission-form").addEventListener("submit", handleCommissionCreate);
$("skill-commissions").addEventListener("submit", handleCommissionSubmit);
$("skill-commissions").addEventListener("click", handleCommissionAction);

export const skillCommissionsFeature = {
  loadCommissions,
  refreshProtected() {
    void loadCommissions();
  },
  lockProtected() {
    commissions = [];
    trialRuns = [];
    $("skill-commissions").innerHTML = '<p class="skill-empty">操作员登录已失效；重新登录后显示能力委任。</p>';
  },
};

async function loadCommissions() {
  const container = $("skill-commissions");
  if (!operatorSession.authenticated) {
    container.innerHTML = '<p class="skill-empty">输入操作员 Token 后显示能力委任。对话、试用和激活记录默认不公开。</p>';
    return;
  }
  container.innerHTML = '<p class="skill-empty">正在读取能力委任…</p>';
  try {
    const [{ commissions: nextCommissions }, { runs }] = await Promise.all([
      operatorApi("/api/skills/commissions"), operatorApi("/api/skills/trial-runs"),
    ]);
    trialRuns = runs;
    commissions = nextCommissions;
    renderCommissions(commissions);
  } catch (error) {
    container.innerHTML = `<p class="skill-empty error">能力委任读取失败：${escapeHtml(error.message)}</p>`;
  }
}

function renderCommissions(items) {
  const container = $("skill-commissions");
  if (!items.length) {
    container.innerHTML = '<p class="skill-empty">还没有能力委任。先用左侧对话告诉 Chief 想让谁学会什么，以及如何判断变好了。</p>';
    return;
  }
  container.innerHTML = items.map((commission) => {
    const pkg = commission.package;
    const acceptedTrials = commission.trials.filter((trial) => trial.outcome === "accepted").length;
    const mayContinue = ["discovering", "draft"].includes(commission.status);
    const packageDetails = pkg ? `<details>
      <summary>查看规范包与 digest</summary>
      <dl class="skill-route">
        <div><dt>Skill</dt><dd>${escapeHtml(pkg.skill_id)} v${pkg.version}</dd></div>
        <div><dt>目标成员</dt><dd>${escapeHtml(pkg.target_member_id)}</dd></div>
        <div><dt>专业服务</dt><dd>${escapeHtml(pkg.target_service_id)}</dd></div>
      </dl>
      <p class="skill-digest">SHA-256 ${escapeHtml(pkg.digest)}</p>
      <p><b>触发：</b>${escapeHtml(pkg.trigger)}</p>
      <p><b>工作方法：</b>${pkg.instructions.map(escapeHtml).join(" · ")}</p>
      <p><b>边界：</b>${pkg.boundaries.map(escapeHtml).join(" · ")}</p>
      <p><b>验收：</b>${pkg.acceptance_examples.map(escapeHtml).join(" · ")}</p>
    </details>` : "";
    const transcript = commission.messages.slice(-6).map((message) => `<div class="skill-message ${escapeHtml(message.role)}"><strong>${message.role === "chief" ? "CHIEF" : "USER"}</strong><p>${escapeHtml(message.content)}</p></div>`).join("");
    const trials = commission.trials.length
      ? `<ul class="skill-trials">${commission.trials.map((trial) => `<li>${escapeHtml(trial.outcome)} · ${escapeHtml(trial.summary)} · Reviewer ${escapeHtml(trial.reviewer_member_id)} · ${trial.metrics.baseline.total_tokens} → ${trial.metrics.trial.total_tokens} Tokens · ${trial.metrics.baseline.latency_ms} → ${trial.metrics.trial.latency_ms} ms</li>`).join("")}</ul>`
      : '<p class="chips">尚无试用证据；激活前至少需要三次独立验收。</p>';
    return `<article class="skill-commission ${escapeHtml(commission.status)}" data-commission-id="${escapeHtml(commission.id)}">
      <div class="skill-commission-head"><div><h4>${escapeHtml(commission.title)}</h4><p>${escapeHtml(commission.goal)}</p></div><span class="skill-state">${escapeHtml(skillStatusLabel(commission.status))}</span></div>
      <dl class="skill-route">
        <div><dt>Chief</dt><dd>${escapeHtml(commission.chief_member_id)}</dd></div>
        <div><dt>装备目标</dt><dd>${escapeHtml(commission.target_member_id || "澄清中")}</dd></div>
        <div><dt>风险</dt><dd>${escapeHtml(commission.risk)}</dd></div>
      </dl>
      <div class="skill-transcript">${transcript}</div>
      ${packageDetails}
      ${["trial", "activation_proposed", "active", "suspended"].includes(commission.status) ? trials : ""}
      ${mayContinue ? `<form class="skill-continue-form"><label>${commission.status === "discovering" ? "回答 Chief" : "继续修订草案"}<textarea name="message" required maxlength="8000" placeholder="补充边界、目标成员或可验收例子"></textarea></label><button type="submit" class="secondary">发送到同一委任</button></form>` : ""}
      ${commission.status === "trial" ? renderTrialForm(commission) : ""}
      <div class="skill-actions">
        ${commission.status === "draft" ? '<button type="button" data-skill-action="validate">校验并进入试用</button>' : ""}
        ${commission.status === "trial" ? `<button type="button" data-skill-action="propose" ${acceptedTrials < 3 ? "disabled" : ""}>提议正式装备（${acceptedTrials}/3）</button>` : ""}
        ${commission.status === "activation_proposed" ? '<button type="button" data-skill-action="activate">批准装备</button>' : ""}
        ${commission.status === "active" ? '<button type="button" class="secondary" data-skill-action="rollback">回滚此版本</button>' : ""}
        ${!["active", "suspended", "cancelled"].includes(commission.status) ? '<button type="button" class="secondary" data-skill-action="cancel">取消委任</button>' : ""}
      </div>
    </article>`;
  }).join("");
}

function renderTrialForm(commission) {
  const workplaces = state.settlement?.workplaces ?? [];
  const reviewers = (state.tribe?.members ?? []).filter((member) => (
    member.id !== commission.target_member_id
    && member.roles.includes("reviewer")
    && !["inactive", "retired"].includes(member.status)
  ));
  const runs = trialRuns.filter((run) => run.commission_id === commission.id);
  return `<section class="skill-auto-trial">
    <div><h5>让部落完成对照试炼</h5><p>目标成员运行同一工作地与目标的基线和固定 Skill 版本，独立测试成员比较证据；不会执行 Git 提交。</p></div>
    <form class="skill-auto-trial-form" data-commission-id="${escapeHtml(commission.id)}">
      <div class="grid-two"><label>测试工作地<select name="workplace_id" required>${workplaces.length ? workplaces.map((workplace) => `<option value="${escapeHtml(workplace.id)}">${escapeHtml(workplace.name)} · ${escapeHtml(workplace.id)}</option>`).join("") : '<option value="">请先在任务大厅登记工作地</option>'}</select></label><label>独立测试成员<select name="reviewer_member_id" required>${reviewers.length ? reviewers.map((member) => `<option value="${escapeHtml(member.id)}" ${member.id === "qwen_worker" ? "selected" : ""}>${escapeHtml(member.name)} · ${escapeHtml(member.id)}</option>`).join("") : '<option value="">暂无可用 Reviewer</option>'}</select></label></div>
      <label>试炼目标<input name="goal" required maxlength="2000" value="${escapeHtml(commission.goal)}"></label>
      <div class="grid-two"><label>Git 流程<select name="mode"><option value="commit">只形成 Commit 计划</option><option value="pull_request">形成 PR 计划</option><option value="merge">形成 Merge 计划</option></select></label><label>Issue 策略<select name="issue_mode"><option value="none">不创建 Issue</option><option value="auto">按策略规划 Issue</option></select></label></div>
      <button type="submit" ${!workplaces.length || !reviewers.length ? "disabled" : ""}>开始成员试炼</button>
    </form>
    <div class="skill-trial-run-region" data-trial-runs-for="${escapeHtml(commission.id)}" aria-live="polite" aria-atomic="true">${renderTrialRuns(runs)}</div>
  </section>
  <details><summary>高级：登记已有试炼证据</summary><form class="skill-trial-form" data-commission-id="${escapeHtml(commission.id)}">
    <p class="chips">先在任务大厅对同一 Git 工作地与目标运行一次基线；再把本案卷 ID <code>${escapeHtml(commission.id)}</code> 填入“试用中的 Skill Commission ID”后重跑。Token、耗时和验收结论从两份专业任务证据自动读取。</p>
    <div class="grid-two"><label>无 Skill 基线证据 ID<input name="baseline_evidence_id" required></label><label>使用 Skill 的试用证据 ID<input name="trial_evidence_id" required></label></div>
    <div class="grid-two"><label>独立 Reviewer<input name="reviewer_member_id" value="${escapeHtml(commission.chief_member_id)}" required></label><label>试用结论<select name="outcome"><option value="accepted">通过</option><option value="rejected">未通过</option></select></label></div>
    <label>Reviewer 摘要<input name="summary" required maxlength="500" placeholder="说明相对基线改善或退化的证据"></label>
    <button type="submit" class="secondary">登记试用证据</button>
  </form></details>`;
}

function renderTrialRuns(runs) {
  if (!runs.length) return '<p class="skill-trial-run-empty">还没有自动试炼。一次试炼会留下目标成员、Reviewer、两份 Evidence ID 和结论。</p>';
  return `<ol class="skill-trial-runs" aria-label="自动试炼进度">${runs.map((run) => {
    const outcome = run.review?.outcome;
    return `<li class="${escapeHtml(outcome || run.status)}"><div><strong>${escapeHtml(outcome === "accepted" ? "试炼通过" : outcome === "rejected" ? "试炼未通过" : trialStageLabel(run.stage))}</strong><span>${escapeHtml(outcome || run.status)}</span></div><p>${escapeHtml(run.review?.rationale || run.error || `${memberLabel(run.target_member_id)} 正在与 ${memberLabel(run.reviewer_member_id)} 协作`)}</p><small>${escapeHtml(formatObservatoryTime(run.updated_at))}${run.baseline_evidence_id ? ` · 基线 <code>${escapeHtml(run.baseline_evidence_id)}</code>` : ""}${run.trial_evidence_id ? ` · 试用 <code>${escapeHtml(run.trial_evidence_id)}</code>` : ""}</small></li>`;
  }).join("")}</ol>`;
}

async function handleCommissionCreate(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("skill-commission-status").textContent = "Chief 正在澄清这项能力委任…";
  try {
    const commission = await operatorApi("/api/skills/commissions", {
      method: "POST",
      body: JSON.stringify({ message: $("skill-commission-message").value }),
    });
    $("skill-commission-message").value = "";
    $("skill-commission-status").textContent = commission.status === "discovering"
      ? "Chief 已提出澄清问题，请在案卷中继续对话。"
      : "Chief 已形成草案，请检查后进入试用。";
    await loadCommissions();
  } catch (error) {
    $("skill-commission-status").textContent = `委任失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function handleCommissionSubmit(event) {
  const card = event.target.closest("[data-commission-id]");
  if (!card) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    if (form.classList.contains("skill-continue-form")) {
      await operatorApi(`/api/skills/commissions/${encodeURIComponent(card.dataset.commissionId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: new FormData(form).get("message") }),
      });
    } else if (form.classList.contains("skill-auto-trial-form")) {
      const data = new FormData(form);
      const trialInput = {
        workplace_id: data.get("workplace_id"),
        goal: data.get("goal"),
        reviewer_member_id: data.get("reviewer_member_id"),
        mode: data.get("mode"),
        issue_mode: data.get("issue_mode"),
      };
      const idempotency = trialIdempotency(card.dataset.commissionId, trialInput);
      const run = await operatorApi(`/api/skills/commissions/${encodeURIComponent(card.dataset.commissionId)}/run-trial`, {
        method: "POST",
        body: JSON.stringify({ idempotency_key: idempotency.key, ...trialInput }),
      });
      $("skill-commission-status").textContent = "成员试炼已开始：目标成员先跑基线，再加载固定 Skill，由独立 Reviewer 验收。";
      await waitForTrialRun(run.id);
      sessionStorage.removeItem(idempotency.storageKey);
    } else if (form.classList.contains("skill-trial-form")) {
      const data = new FormData(form);
      await operatorApi(`/api/skills/commissions/${encodeURIComponent(card.dataset.commissionId)}/trials`, {
        method: "POST",
        body: JSON.stringify({
          baseline_evidence_id: data.get("baseline_evidence_id"),
          trial_evidence_id: data.get("trial_evidence_id"),
          reviewer_member_id: data.get("reviewer_member_id"),
          outcome: data.get("outcome"),
          summary: data.get("summary"),
        }),
      });
    }
    await loadCommissions();
  } catch (error) {
    $("skill-commission-status").textContent = `能力委任操作失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function handleCommissionAction(event) {
  const button = event.target.closest("[data-skill-action]");
  const card = button?.closest("[data-commission-id]");
  if (!button || !card) return;
  const action = button.dataset.skillAction;
  const paths = {
    validate: "validate",
    propose: "propose-activation",
    activate: "activate",
    rollback: "rollback",
    cancel: "cancel",
  };
  button.disabled = true;
  try {
    await operatorApi(`/api/skills/commissions/${encodeURIComponent(card.dataset.commissionId)}/${paths[action]}`, {
      method: "POST",
      body: JSON.stringify(action === "activate" ? { approved_by: "operator" } : action === "rollback" ? { reviewed_by: "operator" } : {}),
    });
    await loadCommissions();
  } catch (error) {
    $("skill-commission-status").textContent = `能力委任操作失败：${error.message}`;
    button.disabled = false;
  }
}

async function waitForTrialRun(id) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const run = await operatorApi(`/api/skills/trial-runs/${encodeURIComponent(id)}`);
    const existing = trialRuns.findIndex((candidate) => candidate.id === run.id);
    if (existing >= 0) trialRuns[existing] = run;
    else trialRuns.unshift(run);
    const region = [...document.querySelectorAll("[data-trial-runs-for]")]
      .find((candidate) => candidate.dataset.trialRunsFor === run.commission_id);
    if (region) region.innerHTML = renderTrialRuns(
      trialRuns.filter((candidate) => candidate.commission_id === run.commission_id),
    );
    if (["completed", "failed"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("成员试炼仍在运行，请稍后刷新查看");
}

function trialIdempotency(commissionId, input) {
  const storageKey = `totemora_skill_trial:${commissionId}`;
  const signature = JSON.stringify(input);
  try {
    const existing = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (existing?.signature === signature && existing?.key) return { storageKey, key: existing.key };
  } catch {}
  const key = crypto.randomUUID();
  sessionStorage.setItem(storageKey, JSON.stringify({ signature, key }));
  return { storageKey, key };
}
