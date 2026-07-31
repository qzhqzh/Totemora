const $ = (id) => document.getElementById(id);
$("operator-form").addEventListener("submit", (event) => event.preventDefault());
const phases = { queued: 8, planning: 25, executing: 55, reviewing: 78, repairing: 68, cancelling: 85, cancelled: 100, completed: 100, failed: 100 };
let tribe;
let status;
let settlement;
let activeJobId;
let activeDevelopmentProposal;
let memberDossiers = [];
let activeMemberId;

$("operator-token").value = sessionStorage.getItem("totemora_operator_token") || "";
$("operator-token").addEventListener("change", () => {
  sessionStorage.setItem("totemora_operator_token", $("operator-token").value);
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
  await Promise.all([loadEmbers(), loadAssets(), loadMemberDossiers(), loadIntelligence(), loadIntelligencePreferences()]);
  $("chief").innerHTML = tribe.members.filter((m) => m.roles.includes("chief") && !["inactive", "retired"].includes(m.status))
    .map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === tribe.tribe.chief ? "selected" : ""}>${escapeHtml(m.name)} · ${escapeHtml(m.model)}</option>`).join("");
  await loadHistory();
  await loadSettlement();
  await loadDevelopmentHistory();
}

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
  const members = tribe.members.filter((member) => !["inactive", "retired"].includes(member.status));
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

async function loadMemberDossiers() {
  const result = await api("/api/members/dossiers");
  memberDossiers = result.members.filter((item) => !["inactive", "retired"].includes(item.member.status));
  activeMemberId ||= memberDossiers[0]?.member.id;
  $("member-tabs").innerHTML = memberDossiers.map((item) => `<button type="button" class="member-tab ${item.member.id === activeMemberId ? "active" : ""}" data-member="${escapeHtml(item.member.id)}">
    <b>${escapeHtml(item.member.name || item.member.id)}</b><small>${escapeHtml(item.identity.rank)} · ${escapeHtml(item.member.status || "active")}</small>
  </button>`).join("");
  $("member-tabs").querySelectorAll("[data-member]").forEach((button) => button.addEventListener("click", () => {
    activeMemberId = button.dataset.member; void loadMemberDossiers();
  }));
  const dossier = memberDossiers.find((item) => item.member.id === activeMemberId);
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
    try { await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/evolution/proposals`, { method: "POST", body: "{}" }); await loadMemberDossiers(); }
    catch (error) { alert(error.message); event.currentTarget.disabled = false; }
  });
  $("member-dossier").querySelectorAll("[data-evolution]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/evolution/proposals/${encodeURIComponent(button.dataset.proposal)}/review`, {
        method: "POST", body: JSON.stringify({ approve: button.dataset.evolution === "approve", reviewer_id: dossier.identity.mentor?.id || tribe.tribe.chief }),
      });
      await loadMemberDossiers();
    } catch (error) { alert(error.message); button.disabled = false; }
  }));
  await loadMemberConversation();
}

async function loadMemberConversation() {
  if (!activeMemberId) return;
  const { messages } = await api(`/api/members/${encodeURIComponent(activeMemberId)}/messages`);
  $("member-conversation").innerHTML = messages.slice(-30).map((item) => `<article class="chat-message ${escapeHtml(item.role)}"><small>${escapeHtml(item.author_id)} · ${escapeHtml(item.role)}</small><p>${escapeHtml(item.content)}</p></article>`).join("") || "<p class=\"section-note\">营帐还没有对话。</p>";
  $("member-conversation").scrollTop = $("member-conversation").scrollHeight;
}

$("member-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeMemberId) return;
  const button = event.submitter; button.disabled = true;
  try {
    await operatorApi(`/api/members/${encodeURIComponent(activeMemberId)}/chat`, {
      method: "POST", body: JSON.stringify({ message: $("member-message").value, ask_mentor: $("ask-mentor").checked }),
    });
    $("member-message").value = ""; $("ask-mentor").checked = false;
    await loadMemberDossiers();
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; }
});

async function loadIntelligence() {
  const [{ briefs }, pool] = await Promise.all([api("/api/intelligence"), api("/api/intelligence/candidates")]);
  $("candidate-summary").textContent = `待推送 ${pool.counts.queued || 0} · 重试等待 ${pool.counts.retry_wait || 0} · 通道阻塞 ${pool.counts.channel_blocked || 0} · 已抑制 ${pool.counts.held || 0} · 已推送 ${pool.counts.pushed || 0} · 永久失败 ${pool.counts.failed || 0} · 状态未知 ${pool.counts.delivery_unknown || 0}`;
  $("intelligence-candidates").innerHTML = pool.candidates.slice(0, 12).map((item) => `<article class="brief ${escapeHtml(item.status)}" data-candidate="${escapeHtml(item.id)}"><h3>${escapeHtml(item.headline)}</h3><p>${escapeHtml(item.brief)}</p><div class="chips">${escapeHtml(item.status)} · 总分 ${Math.round(item.scores.total * 100)}（模型 ${Math.round((item.scores.base_total ?? item.scores.total) * 100)} / 反馈 ${Math.round((item.scores.feedback_adjustment || 0) * 100)}） · 重要 ${Math.round(item.scores.importance * 100)} · 兴趣 ${Math.round(item.scores.interest * 100)} · 可信 ${Math.round(item.scores.confidence * 100)} · 新颖 ${Math.round(item.scores.novelty * 100)}</div><small>${escapeHtml(item.decision)} · ${escapeHtml(item.rationale)}</small><div class="candidate-feedback" role="group" aria-label="评价这条候选消息"><button type="button" data-feedback="valuable">有价值 ${item.feedback?.valuable || ""}</button><button type="button" data-feedback="not_valuable">没价值 ${item.feedback?.not_valuable || ""}</button><button type="button" data-feedback="duplicate">重复 ${item.feedback?.duplicate || ""}</button><button type="button" data-feedback="too_late">太晚 ${item.feedback?.too_late || ""}</button></div><small class="feedback-status" aria-live="polite">${item.feedback?.opened ? `Bark 已打开 ${item.feedback.opened} 次` : "反馈会校正后续相似消息，不改写本次模型原始分"}</small></article>`).join("") || "<p class=\"section-note\">候选池为空。可以立即扫描；如果来源或模型失败，失败原因会留在扫描记录中。</p>";
  $("intelligence-history").innerHTML = briefs.slice(0, 8).map((brief) => `<article class="brief ${escapeHtml(brief.status)}"><h3>${escapeHtml(brief.title)}</h3><p>${escapeHtml(brief.summary || brief.error || "")}</p><div class="chips">${escapeHtml(brief.created_at)} · 来源 ${brief.sources.length} · Bark ${brief.pushed_messages}</div>${brief.items.map((item) => `<p><b>${escapeHtml(item.headline)}</b><br><small>${escapeHtml(item.brief)}</small></p>`).join("")}</article>`).join("") || "<p class=\"section-note\">听风尚未带回情报。</p>";
  if ($("operator-token").value) {
    try {
      const bark = await operatorApi("/api/intelligence/bark?health=1");
      $("bark-status").className = `channel-status ${bark.healthy ? "ready" : bark.channel_status}`;
      $("bark-status").textContent = bark.configured
        ? `内部 Bark ${bark.healthy ? "在线" : bark.channel_status} · ${bark.server_url || ""} · 连续失败 ${bark.consecutive_failures}${bark.retry_after ? ` · ${bark.retry_after} 后重试` : ""}`
        : "内部 Bark 尚未配置 device key；扫描仍会继续，候选不会丢失";
    } catch (error) {
      $("bark-status").className = "channel-status error";
      $("bark-status").textContent = `Bark 状态读取失败：${error.message}`;
    }
  } else {
    $("bark-status").textContent = "输入操作员 Token 后可检查内部 Bark 健康状态";
  }
}

$("intelligence-candidates").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-feedback]");
  if (!button) return;
  const card = button.closest("[data-candidate]");
  const statusNode = card.querySelector(".feedback-status");
  card.querySelectorAll("[data-feedback]").forEach((item) => { item.disabled = true; });
  statusNode.classList.remove("error");
  statusNode.textContent = "正在记录反馈并更新相似消息偏好…";
  try {
    const result = await operatorApi(`/api/intelligence/candidates/${encodeURIComponent(card.dataset.candidate)}/feedback`, {
      method: "POST", body: JSON.stringify({ signal: button.dataset.feedback }),
    });
    statusNode.textContent = result.inserted ? "反馈已记录；下一轮相似消息评估会使用这条证据" : "这条反馈已记录过，没有重复计权";
    await Promise.all([loadIntelligence(), loadMemberDossiers()]);
  } catch (error) {
    statusNode.classList.add("error");
    statusNode.textContent = `反馈失败：${error.message}。可再次点击重试。`;
    card.querySelectorAll("[data-feedback]").forEach((item) => { item.disabled = false; });
  }
});

async function loadIntelligencePreferences() {
  const value = await api("/api/intelligence/preferences");
  $("intelligence-interests").value = value.interests.join("\n");
  $("channel-rss").checked = value.channels.rss;
  $("channel-ai-hot").checked = value.channels.ai_hot;
  $("channel-x").checked = value.channels.x_trends;
  $("channel-weibo").checked = value.channels.weibo_hot;
  $("x-woeid").value = value.x_woeid;
  $("scan-interval").value = value.scan_interval_minutes;
  $("push-interval").value = value.push_interval_seconds;
  $("push-threshold").value = value.push_threshold;
  $("social-credential-status").textContent = `只读凭据：X ${value.credentials?.x_trends ? "已配置" : "未配置"} · 微博 ${value.credentials?.weibo_hot ? "已配置" : "未配置"}`;
}

$("intelligence-preferences").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    await operatorApi("/api/intelligence/preferences", { method: "PUT", body: JSON.stringify({
      interests: $("intelligence-interests").value.split("\n").map((item) => item.trim()).filter(Boolean),
      channels: {
        rss: $("channel-rss").checked,
        ai_hot: $("channel-ai-hot").checked,
        x_trends: $("channel-x").checked,
        weibo_hot: $("channel-weibo").checked,
      },
      x_woeid: Number($("x-woeid").value),
      scan_interval_minutes: Number($("scan-interval").value),
      push_interval_seconds: Number($("push-interval").value),
      push_threshold: Number($("push-threshold").value),
      novelty_history_hours: 72,
    }) });
    $("intelligence-preference-status").textContent = "偏好已保存；下一轮巡查生效";
  } catch (error) { $("intelligence-preference-status").textContent = error.message; }
  finally { button.disabled = false; }
});

$("run-intelligence").addEventListener("click", async () => {
  const button = $("run-intelligence"); button.disabled = true; $("intelligence-status").textContent = "听风正在扫描、聚类并评估候选消息…";
  try {
    const task = await operatorApi("/api/intelligence/tasks", {
      method: "POST", body: JSON.stringify({ message_count: 3, delivery_mode: "candidate_pool", idempotency_key: `web-scan-${Date.now()}` }),
    });
    let current = task;
    while (!["completed", "failed"].includes(current.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      current = await operatorApi(`/api/intelligence/tasks/${encodeURIComponent(task.id)}`);
      $("intelligence-status").textContent = `听风任务 ${current.status}…`;
    }
    if (current.status === "failed") throw new Error(current.error || "情报任务失败");
    const brief = current.result;
    const growth = current.growth_review?.status === "proposed" ? "；导师已生成成长提案" : "";
    $("intelligence-status").textContent = `扫描完成：${brief.title}，形成 ${brief.candidate_ids?.length || 0} 条候选，${brief.queued_messages || 0} 条进入推送队列${growth}`;
    await Promise.all([loadIntelligence(), loadMemberDossiers(), loadAssets()]);
  } catch (error) { $("intelligence-status").textContent = error.message; $("intelligence-status").classList.add("error"); }
  finally { button.disabled = false; }
});

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
  $("policy-target-branch").value = workplace?.policy?.git_flow?.target_branch || "main";
  $("policy-remote-enabled").checked = workplace?.policy?.git_flow?.remote_provider === "github";
  $("policy-merge-enabled").checked = Boolean(workplace?.policy?.git_flow?.allow_merge);
  $("policy-opencode-enabled").checked = Boolean(workplace?.policy?.git_flow?.allow_opencode_fix);
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
    const workplace = await operatorApi("/api/workplaces", { method: "POST", body: JSON.stringify({ name: $("workplace-name").value, path: $("workplace-path").value }) });
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
        git_flow: {
          remote_provider: $("policy-remote-enabled").checked ? "github" : "none",
          target_branch: $("policy-target-branch").value.trim() || "main",
          allow_issue: $("policy-remote-enabled").checked,
          allow_push: $("policy-remote-enabled").checked,
          allow_pull_request: $("policy-remote-enabled").checked,
          allow_merge: $("policy-merge-enabled").checked,
          allow_opencode_fix: $("policy-opencode-enabled").checked,
        },
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
    const job = await operatorApi("/api/runs", { method: "POST", body: JSON.stringify({
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
  $("run-message").textContent = "Chief 正在把目标路由给 Git 流程专员，并验收其计划";
  $("progress-bar").style.width = "45%";
  const proposal = await operatorApi("/api/development/prepare", {
    method: "POST",
    body: JSON.stringify({
      workplace_id: $("workplace").value, goal: $("goal").value,
      mode: $("git-flow-mode").value,
      issue_mode: $("git-flow-mode").value === "commit" ? "none" : "auto",
    }),
  });
  activeDevelopmentProposal = proposal.id;
  renderDevelopmentProposal(proposal);
  await loadDevelopmentHistory();
}

function renderDevelopmentProposal(proposal) {
  $("phase").textContent = proposal.status.toUpperCase();
  $("progress-bar").style.width = proposal.status === "completed" ? "100%" : "70%";
  $("development-proposal").innerHTML = `<article class="proposal">
    <h3>Git Flow 工作流</h3>
    <p>${escapeHtml(proposal.summary)}</p>
    <p><b>${escapeHtml(proposal.commit_message)}</b></p>
    <div class="chips">Chief / ${escapeHtml(proposal.chief_member_id)} → Git流程专员 / ${escapeHtml(proposal.specialist_member_id)} → Chief 验收</div>
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
}

async function advanceDevelopment(gate) {
  if (!activeDevelopmentProposal) return;
  $("phase").textContent = "EXECUTING";
  $("run-message").textContent = `正在推进 ${gate} 门禁`;
  const proposal = await operatorApi(`/api/development/proposals/${activeDevelopmentProposal}/advance`, {
    method: "POST", body: JSON.stringify({ gate }),
  });
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
  try { await operatorApi(`/api/runs/${activeJobId}/cancel`, { method: "POST" }); }
  catch (error) { renderError(error.message); }
});

$("retry-run").addEventListener("click", async () => {
  if (!activeJobId) return;
  $("retry-run").disabled = true;
  try {
    const job = await operatorApi(`/api/runs/${activeJobId}/retry`, { method: "POST" });
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
