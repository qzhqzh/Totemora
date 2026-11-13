import { copyText, escapeHtml, externalLink, formatObservatoryTime } from "../shared/dom.js";
import { operatorApi, operatorSession } from "../shared/operator-session.js";

const endpoint = "/api/intelligence/radar/actions";
const decisions = new Map();
const drafts = new Map();
const labels = { proposed: "待审核", accepted: "已采纳 · 待交接", dismissed: "已忽略" };

export const projectRadarActionsFeature = {
  lockProtected() { decisions.clear(); drafts.clear(); },
  render(actions) {
    return `<h3>行动建议</h3><p class="section-note">结合项目目标和来源证据决定下一步。采纳后可查看交接草稿；正式任务仍需在 Lifeline 中创建和验收。</p>
      <div class="intelligence-history">${actions.slice(0, 50).map(renderAction).join("") || '<p class="section-note">暂无行动建议。先保存关注项目，再评估候选消息。</p>'}</div>`;
  },
  async handleClick(button, { mutate, status }) {
    const card = button.closest("[data-radar-suggestion]");
    if (!card || !operatorSession.authenticated) return;
    const id = card.dataset.radarSuggestion;
    const decision = button.dataset.radarDecision;
    if (decision === "accept" || decision === "dismiss") {
      const intent = `${id}:${decision}`;
      if (!decisions.has(intent)) decisions.set(intent, `radar:${randomKey()}`);
      return mutate(async () => {
        await operatorApi(`${endpoint}/${encodeURIComponent(id)}/decision`, {
          method: "POST", body: JSON.stringify({ decision, idempotency_key: decisions.get(intent) }),
        });
        return decision === "accept" ? "建议已采纳，等待交接；尚未创建 Lifeline 任务。" : "建议已忽略，判断和证据仍保留。";
      });
    }
    if (button.hasAttribute("data-radar-handoff")) {
      return mutate(async () => {
        const draft = await operatorApi(`${endpoint}/${encodeURIComponent(id)}/handoff`);
        if (draft.status !== "draft" || draft.submitted !== false) throw new Error("交接响应不是未提交的草稿，请刷新核对");
        drafts.set(id, draft);
        return "已读取交接草稿，尚未提交到 Lifeline。";
      });
    }
    if (button.hasAttribute("data-radar-copy")) {
      const draft = drafts.get(id);
      if (!draft) return;
      const revision = operatorSession.revision;
      try {
        await copyText(JSON.stringify(draft, null, 2));
        if (revision === operatorSession.revision) status("交接草稿已复制，尚未提交到 Lifeline。");
      } catch (error) {
        if (revision === operatorSession.revision) status(`复制失败：${error.message}；可手动复制下方草稿。`, true);
      }
    }
  },
};

function renderAction(action) {
  const draft = drafts.get(action.id);
  return `<article class="brief" data-radar-suggestion="${escapeHtml(action.id)}">
    <h4>${escapeHtml(action.title)}</h4><p class="chips">${escapeHtml(action.project_name)} · ${action.method === "rules" ? "规则匹配" : "Jev 评估"} · ${escapeHtml(labels[action.status] || action.status)}</p>
    <p>${escapeHtml(action.rationale)}</p><p><strong>建议下一步：</strong>${escapeHtml(action.next_step)}</p>
    <p class="domain-status">验收依据</p><ul>${(action.acceptance_criteria || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    <p class="domain-status">来源证据</p><ul>${(action.evidence || []).map((item) => `<li>${externalLink(item.url, item.title || "查看证据")}</li>`).join("")}</ul>
    <small>${escapeHtml(formatObservatoryTime(action.created_at))}</small>
    <div class="finance-actions">${action.status === "proposed"
      ? '<button type="button" data-radar-decision="accept">采纳建议</button><button type="button" data-radar-decision="dismiss" class="secondary">忽略建议</button>'
      : action.status === "accepted" ? '<button type="button" data-radar-handoff class="secondary">查看交接草稿</button>' : ""}</div>
    ${action.status === "accepted" && draft ? renderDraft(draft) : ""}</article>`;
}

function renderDraft(draft) {
  return `<div data-radar-draft><p class="section-note">待交接草稿 · 尚未提交到 Lifeline。${draft.ready === true ? "已具备映射信息，创建任务前仍需核对。" : "仍需确认真实的 Lifeline 项目与阶段映射。"}</p>
    <label>交接草稿（JSON）<textarea data-radar-handoff-json readonly rows="8">${escapeHtml(JSON.stringify(draft, null, 2))}</textarea></label>
    <button type="button" data-radar-copy class="secondary">复制交接草稿</button></div>`;
}

function randomKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
