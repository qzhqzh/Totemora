import { state } from "../shared/app-context.js";
import { $, escapeHtml } from "../shared/dom.js";
import { api, operatorApi } from "../shared/operator-session.js";

let dossiers = [];
let activeMemberId;

$("member-chat-form").addEventListener("submit", handleMemberChat);

export const membersFeature = {
  loadAssets,
  loadDossiers,
  loadEmbers,
  renderCodex,
};

async function loadAssets() {
  const { assets } = await api("/api/assets");
  $("assets").innerHTML = assets.map((asset) => {
    const grants = asset.authorized_members.map((member) => escapeHtml(member.name)).join(" · ") || "尚未授予成员";
    const evidence = asset.evidence.length
      ? `${asset.evidence.length} 条已验证流程 · 最近 ${escapeHtml(asset.evidence[0].workflow_id)}`
      : `${asset.usage_count} 次调用 · 尚无完成态流程证据`;
    return `<article class="asset-card ${escapeHtml(asset.maturity)}">
      <div class="asset-meta"><span>${escapeHtml(asset.kind)}</span><b>${escapeHtml(asset.maturity)}</b></div>
      <h3>${escapeHtml(asset.name)} <small>v${asset.version}</small></h3>
      <p>${escapeHtml(asset.summary)}</p>
      <dl><dt>执行器</dt><dd>${escapeHtml(asset.executor)}</dd><dt>风险 / 默认</dt><dd>${escapeHtml(asset.risk)} / ${escapeHtml(asset.default_access)}</dd><dt>授权成员</dt><dd>${grants}</dd></dl>
      <div class="chips">能力 / ${asset.actions.map(escapeHtml).join(" · ") || "仅候选图纸"}<br>策略 / ${asset.policy_requirements.map(escapeHtml).join(" · ")}</div>
      <div class="asset-evidence">${evidence}</div>
      <small>图纸：${escapeHtml(asset.blueprint.source)} · ${escapeHtml(asset.blueprint.notes)}</small>
    </article>`;
  }).join("");
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
  const members = (state.tribe?.members ?? []).filter((member) => !["inactive", "retired"].includes(member.status));
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

async function loadDossiers() {
  const result = await api("/api/members/dossiers");
  dossiers = result.members.filter((item) => !["inactive", "retired"].includes(item.member.status));
  activeMemberId ||= dossiers[0]?.member.id;
  $("member-tabs").innerHTML = dossiers.map((item) => `<button type="button" class="member-tab ${item.member.id === activeMemberId ? "active" : ""}" data-member="${escapeHtml(item.member.id)}">
    <b>${escapeHtml(item.member.name || item.member.id)}</b><small>${escapeHtml(item.identity.rank)} · ${escapeHtml(item.member.status || "active")}</small>
  </button>`).join("");
  $("member-tabs").querySelectorAll("[data-member]").forEach((button) => button.addEventListener("click", () => {
    activeMemberId = button.dataset.member;
    void loadDossiers();
  }));
  const dossier = dossiers.find((item) => item.member.id === activeMemberId);
  if (!dossier) return;
  const mentor = dossier.identity.mentor ? `${escapeHtml(dossier.identity.mentor.name)}（${escapeHtml(dossier.identity.mentor.id)}）` : "无固定导师";
  const portrait = dossier.portrait;
  $("member-dossier").innerHTML = `<h3>${escapeHtml(dossier.member.name || dossier.member.id)}</h3>
    <p>${escapeHtml(dossier.member.persona || "")}</p>
    <dl><dt>谱系</dt><dd>${escapeHtml(dossier.identity.discipline)} / ${escapeHtml(dossier.identity.rank)}</dd><dt>导师</dt><dd>${mentor}</dd><dt>年龄</dt><dd>${dossier.identity.age_days} 天</dd><dt>活力</dt><dd>${Math.round(dossier.growth.vitality * 100)}%</dd></dl>
    <div class="chips">经验信用 ${dossier.growth.experience_credit} · 可信结果 ${dossier.growth.verified_successes} · 日常操作 ${dossier.growth.operation_count} · 成员失败 ${dossier.growth.failures} · 系统失败 ${dossier.growth.system_failures || 0}</div>
    <h4>性格内核 · v${portrait.constitution.version}</h4>
    <p><b>特质</b> ${portrait.constitution.traits.map(escapeHtml).join(" · ") || "尚未结构化"}</p>
    <p><b>原则</b> ${portrait.constitution.principles.map(escapeHtml).join(" · ") || "尚未结构化"}</p>
    <p><b>表达</b> ${portrait.constitution.communication_style.map(escapeHtml).join(" · ") || "尚未结构化"}</p>
    <p><b>工作偏好</b> ${portrait.constitution.working_preferences.map(escapeHtml).join(" · ") || "尚未结构化"}</p>
    <h4>观察画像</h4>${portrait.observed_traits.map((item) => `<p>${escapeHtml(item.name)} ${Math.round(item.score * 100)} <small>置信 ${Math.round(item.confidence * 100)} · ${escapeHtml(item.evidence)}</small></p>`).join("")}
    <h4>任务履历</h4><p>完成 ${portrait.task_record.completed} · 验收成功 ${portrait.task_record.accepted} · 经验信用 ${portrait.task_record.experience_credit} · 成功率 ${Math.round(portrait.task_record.success_rate * 100)}%</p>
    <h4>重大经历</h4>${portrait.major_experiences.map((item) => `<p class="memory verified"><b>${escapeHtml(item.title)}</b> ${escapeHtml(item.summary.length > 260 ? `${item.summary.slice(0, 260)}…` : item.summary)}<small>${escapeHtml(item.at)}</small></p>`).join("") || "<small>尚无重大经历</small>"}
    <h4>成长提案</h4>${portrait.evolution.pending.map((item) => `<article class="memory"><b>${escapeHtml(item.rationale)}</b><p><strong>建议改动</strong> ${escapeHtml(Object.entries(item.proposed_changes).map(([field, values]) => `${field}: ${(values || []).join(" · ")}`).join("；"))}</p><p><strong>预期收益</strong> ${escapeHtml(item.expected_benefit)}</p><p><strong>风险</strong> ${item.risks.map(escapeHtml).join(" · ")}</p><small>由 ${escapeHtml(item.proposed_by)} 提出 · 基于 v${item.base_version}</small><div><button type="button" data-evolution="approve" data-proposal="${escapeHtml(item.id)}">批准升级</button><button type="button" class="secondary" data-evolution="reject" data-proposal="${escapeHtml(item.id)}">拒绝</button></div></article>`).join("") || "<small>当前没有待审提案</small>"}
    ${portrait.evolution.active_effect ? `<p class="evolution-effect"><b>上次成长已实际生效</b><br>v${portrait.evolution.active_effect.before_version} → v${portrait.evolution.active_effect.after_version}；下一次任务起，提示词使用新的 ${portrait.evolution.active_effect.changed_fields.map(escapeHtml).join("、")}。当前处于 ${escapeHtml(portrait.evolution.active_effect.evaluation_status)}，已观察 ${portrait.evolution.active_effect.observed_experience_credit || 0} / ${portrait.evolution.active_effect.target_credited_tasks} 份经验信用；基线为 ${portrait.evolution.active_effect.baseline.experience_credit} 信用、${portrait.evolution.active_effect.baseline.member_failures} 次成员失败。</p>` : ""}
    ${portrait.evolution.pending.length ? "<small>正式画像保持当前版本，等待提案处理。</small>" : dossier.growth.eligible_growth_proposal ? '<button type="button" class="secondary" id="generate-evolution">请导师提出成长建议</button>' : `<small>距下次成长评审还需 ${dossier.growth.next_review_after_runs} 份经验信用${dossier.growth.review_cooldown_days ? `；冷却还剩 ${dossier.growth.review_cooldown_days} 天` : ""}</small>`}
    <h4>最近经历</h4>${dossier.experiences.slice(0, 6).map((item) => `<p class="memory ${item.verified ? "verified" : ""}"><b>${escapeHtml(item.kind)}</b> ${escapeHtml(item.summary)}<small>${escapeHtml(item.at)}</small></p>`).join("") || "<small>尚未留下经历</small>"}`;

  $("generate-evolution")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/evolution/proposals`, { method: "POST", body: "{}" });
      await loadDossiers();
    } catch (error) {
      alert(error.message);
      event.currentTarget.disabled = false;
    }
  });
  $("member-dossier").querySelectorAll("[data-evolution]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/evolution/proposals/${encodeURIComponent(button.dataset.proposal)}/review`, {
        method: "POST",
        body: JSON.stringify({
          approve: button.dataset.evolution === "approve",
          reviewer_id: dossier.identity.mentor?.id || state.tribe.tribe.chief,
        }),
      });
      await loadDossiers();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  }));
  await loadMemberConversation();
}

async function loadMemberConversation() {
  if (!activeMemberId) return;
  const { messages } = await api(`/api/members/${encodeURIComponent(activeMemberId)}/messages`);
  $("member-conversation").innerHTML = messages.slice(-30).map((item) => `<article class="chat-message ${escapeHtml(item.role)}"><small>${escapeHtml(item.author_id)} · ${escapeHtml(item.role)}</small><p>${escapeHtml(item.content)}</p></article>`).join("") || '<p class="section-note">营帐还没有对话。</p>';
  $("member-conversation").scrollTop = $("member-conversation").scrollHeight;
}

async function handleMemberChat(event) {
  event.preventDefault();
  if (!activeMemberId) return;
  const button = event.submitter;
  button.disabled = true;
  try {
    await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/chat`, {
      method: "POST",
      body: JSON.stringify({ message: $("member-message").value, ask_mentor: $("ask-mentor").checked }),
    });
    $("member-message").value = "";
    $("ask-mentor").checked = false;
    await loadDossiers();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}
