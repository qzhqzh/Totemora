import { state } from "../shared/app-context.js";
import { $, escapeHtml } from "../shared/dom.js";
import { api, operatorApi } from "../shared/operator-session.js";

let analyzeTimer;

$("workplace").addEventListener("change", () => {
  toggleWorkspacePath();
  void analyzeIntake();
});
$("mission").addEventListener("change", () => void analyzeIntake());
$("goal").addEventListener("input", () => {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(analyzeIntake, 250);
});
$("add-workplace").addEventListener("click", addWorkplace);
$("save-policy").addEventListener("click", savePolicy);

export const workplacesFeature = {
  analyzeIntake,
  loadSettlement,
};

async function loadSettlement() {
  state.settlement = await api("/api/settlement");
  $("workplace").innerHTML = '<option value="">临时路径</option>' + state.settlement.workplaces.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.path)}</option>`).join("");
  renderMissionOptions();
  toggleWorkspacePath();
}

function renderMissionOptions() {
  const workplaceId = $("workplace").value;
  const missions = (state.settlement?.missions ?? []).filter((item) => item.status === "active" && (!workplaceId || item.workplace_id === workplaceId));
  $("mission").innerHTML = '<option value="">创建新 Mission</option>' + missions.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)} · ${item.requests.length} 次执行</option>`).join("");
}

function toggleWorkspacePath() {
  $("workspace-label").classList.toggle("hidden", Boolean($("workplace").value));
  renderMissionOptions();
  const workplace = state.settlement?.workplaces.find((item) => item.id === $("workplace").value);
  $("policy-instructions").value = workplace?.policy?.instructions || "";
  $("policy-validations").value = (workplace?.policy?.validation_commands || []).join("\n");
  if (workplace?.policy?.forbidden_paths?.length) $("policy-forbidden").value = workplace.policy.forbidden_paths.join("\n");
  $("policy-target-branch").value = workplace?.policy?.git_flow?.target_branch || "main";
  $("policy-remote-enabled").checked = workplace?.policy?.git_flow?.remote_provider === "github";
  $("policy-merge-enabled").checked = Boolean(workplace?.policy?.git_flow?.allow_merge);
  $("policy-opencode-enabled").checked = Boolean(workplace?.policy?.git_flow?.allow_opencode_fix);
  $("policy-status").textContent = workplace?.policy ? `已安装 Policy v${workplace.policy.version}` : "尚未安装规范";
}

async function analyzeIntake() {
  const analysis = await api("/api/intake/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: $("goal").value,
      workspace: $("workspace").value,
      workplace_id: $("workplace").value,
      mission_id: $("mission").value,
    }),
  });
  const node = $("intake-analysis");
  const developmentReady = analysis.type === "change";
  node.className = `intake-analysis ${analysis.execution_enabled || developmentReady ? "ready" : "gated"}`;
  node.textContent = `${analysis.type.toUpperCase()} · ${analysis.reason}${developmentReady ? " · 已开放受控的现有改动提交" : analysis.execution_enabled ? "" : " · 当前仅完成能力骨架，暂不执行"}`;
  return analysis;
}

async function addWorkplace() {
  try {
    const workplace = await operatorApi("/api/workplaces", {
      method: "POST",
      body: JSON.stringify({ name: $("workplace-name").value, path: $("workplace-path").value }),
    });
    await loadSettlement();
    $("workplace").value = workplace.id;
    toggleWorkspacePath();
  } catch (error) {
    alert(error.message);
  }
}

async function savePolicy() {
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
  } catch (error) {
    alert(error.message);
  }
}

function lines(id) {
  return $(id).value.split("\n").map((value) => value.trim()).filter(Boolean);
}
