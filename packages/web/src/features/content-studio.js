import { state } from "../shared/app-context.js";
import { $, copyText, escapeHtml } from "../shared/dom.js";
import {
  api,
  assertOperatorSession,
  operatorApi,
  operatorFetch,
  operatorSession,
} from "../shared/operator-session.js";
import { membersFeature } from "./members.js";

let works = [];
const illustrationUrls = new Map();

$("content-filter-format").addEventListener("change", renderWorks);
$("content-filter-status").addEventListener("change", renderWorks);
$("content-create-form").addEventListener("submit", handleCreate);
$("content-schedule-form").addEventListener("submit", handleSchedule);
$("content-works").addEventListener("click", handleWorkAction);

export const contentStudioFeature = {
  load: loadContentStudio,
  refreshProtected() {
    void loadContentStudio();
  },
  releaseProtectedResources() {
    for (const url of illustrationUrls.values()) URL.revokeObjectURL(url);
    illustrationUrls.clear();
  },
  lockProtected() {
    this.releaseProtectedResources();
    works = [];
    $("content-create-form").reset();
    $("content-schedule-form").reset();
    $("content-summary").textContent = "操作员登录已失效";
    $("content-works").innerHTML = '<div class="content-empty"><b>作品案卷已锁定</b><p>重新登录后读取部落作品。</p></div>';
    $("content-create-status").textContent = "";
    $("content-schedule-status").textContent = "";
  },
};

async function loadContentStudio() {
  const [preferences, pool] = await Promise.all([
    api("/api/content/preferences"), api("/api/intelligence/candidates"),
  ]);
  $("content-schedule-enabled").checked = preferences.enabled;
  $("content-min-hours").value = preferences.min_interval_hours;
  $("content-max-hours").value = preferences.max_interval_hours;
  $("content-schedule-x").checked = preferences.formats.includes("x_hot_post");
  $("content-schedule-long").checked = preferences.formats.includes("longform_tutorial");
  $("content-schedule-status").textContent = preferences.enabled
    ? `下一次窗口：${preferences.next_run_at ? new Date(preferences.next_run_at).toLocaleString() : "等待排期"}`
    : "自动创作已暂停；手动创作仍可使用";
  $("content-candidate").innerHTML = '<option value="">自动选择高可信候选</option>' + pool.candidates
    .filter((item) => item.scores.confidence >= 0.6)
    .slice(0, 30)
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.headline)} · ${Math.round(item.scores.total * 100)}分</option>`).join("");
  if (!operatorSession.authenticated) {
    works = [];
    $("content-summary").textContent = "输入操作员 Token 后查看未发布作品与配图";
    $("content-works").innerHTML = '<div class="content-empty"><b>创作证据已保护</b><p>作品正文、提示词、失败原因和配图只对操作员开放。</p></div>';
    return;
  }
  works = (await operatorApi("/api/content/works")).works;
  renderWorks();
}

function renderWorks() {
  const format = $("content-filter-format").value;
  const status = $("content-filter-status").value;
  const active = ["queued", "researching", "drafting", "reviewing"];
  const filtered = works.filter((work) => (format === "all" || work.format === format)
    && (status === "all" || work.status === status || (status === "active" && active.includes(work.status))));
  const ready = works.filter((work) => work.status === "ready").length;
  const illustrated = works.filter((work) => work.illustration?.status === "ready").length;
  $("content-summary").textContent = `${works.length} 份作品 · ${ready} 份可复制 · ${illustrated} 份已有配图`;
  $("content-works").innerHTML = filtered.map((work) => {
    const formatLabel = work.format === "x_hot_post" ? "X 热点短帖" : "教程 / 经验长文";
    const statusLabel = ({ queued: "等待召集", researching: "选题研究", drafting: "撰写中", reviewing: "协作审校", ready: "可复制", failed: "未通过" })[work.status] || work.status;
    const members = work.assignments.map((item) => {
      const member = state.tribe?.members.find((entry) => entry.id === item.member_id);
      const role = item.role === "writer" ? "执笔" : item.role === "illustrator" ? "视觉策划 / 配图" : "研究 / 审校";
      return `<span><b>${escapeHtml(member?.name || item.member_id)}</b> · ${role}</span>`;
    }).join("");
    const contributions = work.contributions.map((item) => `<li><b>${escapeHtml(item.member_name)}</b> · ${escapeHtml(item.summary)}</li>`).join("");
    const illustration = work.illustration;
    const illustrationLabel = ({ pending: "等待绘影", briefing: "视觉简报中", generating: "配图生成中", reviewing: "视觉验收中", ready: "配图已就绪", failed: "配图未通过" })[illustration?.status] || "未启用配图";
    const illustrationBlock = illustration ? `<section class="content-illustration ${escapeHtml(illustration.status)}">
      <header><b>${escapeHtml(illustrationLabel)}</b><small>${illustration.image_model ? `${escapeHtml(illustration.image_model)} · ${illustration.attempt_count} 次尝试` : "绘影正在把文章语义翻译成画面"}</small></header>
      ${illustration.status === "ready" ? `<div class="illustration-placeholder" data-content-illustration="${escapeHtml(work.id)}" data-alt="${escapeHtml(illustration.brief?.alt_text || `《${work.title || work.topic}》文章配图`)}" role="status">正在安全读取配图…</div><div class="illustration-evidence"><span>${illustration.width} × ${illustration.height}</span><span>语义 ${Math.round((illustration.review?.semantic_score || 0) * 100)}%</span><span>风格 ${Math.round((illustration.review?.style_score || 0) * 100)}%</span><span>线稿 ${Math.round((illustration.review?.line_quality_score || 0) * 100)}%</span></div>` : `<p>${escapeHtml(illustration.error || illustration.brief?.alt_text || "绘影正在工作，正文不会因图片失败而丢失")}</p>`}
      ${illustration.status === "failed" ? '<button type="button" class="secondary" data-retry-illustration>重新召集绘影</button>' : ""}
    </section>` : "";
    return `<article class="content-work ${escapeHtml(work.status)}" data-content-work="${escapeHtml(work.id)}">
      <header class="content-work-head"><div><span class="content-kind">${formatLabel}</span><h4>${escapeHtml(work.title || work.topic)}</h4></div><span class="content-state">${escapeHtml(statusLabel)}</span></header>
      <div class="content-lineage">${members}</div>
      ${work.body ? `<details class="content-draft"><summary>查看正文 · ${[...work.body].length} 字</summary><pre class="content-body">${escapeHtml(work.body)}</pre></details>` : `<div class="content-progress"><i></i><span>${escapeHtml(work.error || "成员正在工作，页面会自动刷新进度")}</span></div>`}
      ${illustrationBlock}
      <div class="content-source"><span>来源</span>${work.source.url ? `<a href="${escapeHtml(work.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(work.source.headline)}</a>` : `<b>${escapeHtml(work.source.headline)} · 用户选题</b>`}</div>
      <details><summary>协作证据 · ${work.contributions.length} 条</summary><ol class="content-contributions">${contributions || "<li>Chief 已完成路由，等待成员贡献</li>"}</ol>${work.review ? `<p>审校：${escapeHtml(work.review.outcome)} · ${escapeHtml(work.review.rationale)}</p>` : ""}</details>
      <footer><small>v${work.revision} · ${work.usage.calls} 次模型调用 · ${work.usage.total_tokens || 0} Tokens · 已复制 ${work.copy_count} 次</small><div class="content-actions">${illustration?.status === "ready" ? '<button type="button" class="secondary" data-download-illustration>下载配图</button>' : ""}${work.status === "ready" ? '<button type="button" data-copy-content>复制正文</button>' : ""}</div></footer>
      <small class="copy-status" aria-live="polite">${work.status === "ready" ? "复制行为会作为用户采纳信号记入参与成员的经历" : work.error ? escapeHtml(work.error) : ""}</small>
    </article>`;
  }).join("") || '<div class="content-empty"><b>还没有符合条件的作品</b><p>从左侧选择一个情报候选，召集听风与千工完成第一份双人协作内容。</p></div>';
  void hydrateIllustrations();
}

async function hydrateIllustrations() {
  await Promise.all([...document.querySelectorAll("[data-content-illustration]")].map(async (placeholder) => {
    const id = placeholder.dataset.contentIllustration;
    try {
      let url = illustrationUrls.get(id);
      if (!url) {
        const protectedResponse = await operatorFetch(`/api/content/works/${encodeURIComponent(id)}/illustration`);
        const blob = await protectedResponse.response.blob();
        assertOperatorSession(protectedResponse);
        url = URL.createObjectURL(blob);
        illustrationUrls.set(id, url);
      }
      const image = document.createElement("img");
      image.src = url;
      image.alt = placeholder.dataset.alt || "文章配图";
      image.loading = "lazy";
      placeholder.replaceWith(image);
    } catch (error) {
      placeholder.classList.add("error");
      placeholder.textContent = `配图读取失败：${error.message}`;
    }
  }));
}

async function handleCreate(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("content-create-status").classList.remove("error");
  $("content-create-status").textContent = "Chief 正在登记双人创作任务…";
  try {
    const work = await operatorApi("/api/content/works", {
      method: "POST",
      body: JSON.stringify({
        format: $("content-format").value,
        source_candidate_id: $("content-candidate").value || undefined,
        topic: $("content-topic").value.trim() || undefined,
      }),
    });
    $("content-create-status").textContent = "已召集听风、千工与绘影；研究、写作、审校和配图会在后台继续";
    await watchWork(work.id);
  } catch (error) {
    $("content-create-status").classList.add("error");
    $("content-create-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleSchedule(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const formats = [$("content-schedule-x").checked && "x_hot_post", $("content-schedule-long").checked && "longform_tutorial"].filter(Boolean);
    const value = await operatorApi("/api/content/preferences", {
      method: "PUT",
      body: JSON.stringify({
        enabled: $("content-schedule-enabled").checked,
        min_interval_hours: Number($("content-min-hours").value),
        max_interval_hours: Number($("content-max-hours").value),
        formats,
      }),
    });
    $("content-schedule-status").textContent = value.enabled
      ? `节律已保存；下一次窗口 ${new Date(value.next_run_at).toLocaleString()}`
      : "自动创作已暂停；手动创作仍可使用";
  } catch (error) {
    $("content-schedule-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function handleWorkAction(event) {
  const button = event.target.closest("[data-copy-content],[data-retry-illustration],[data-download-illustration]");
  if (!button) return;
  const card = button.closest("[data-content-work]");
  const work = works.find((item) => item.id === card.dataset.contentWork);
  const statusNode = card.querySelector(".copy-status");
  button.disabled = true;
  try {
    if (button.matches("[data-retry-illustration]")) {
      statusNode.textContent = "已重新召集绘影，正在生成并验收…";
      await operatorApi(`/api/content/works/${encodeURIComponent(work.id)}/illustration/retry`, { method: "POST", body: "{}" });
      await watchWork(work.id);
      return;
    }
    if (button.matches("[data-download-illustration]")) {
      const protectedResponse = await operatorFetch(`/api/content/works/${encodeURIComponent(work.id)}/illustration`);
      const blob = await protectedResponse.response.blob();
      assertOperatorSession(protectedResponse);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${work.id}-illustration`;
      link.click();
      URL.revokeObjectURL(url);
      statusNode.textContent = "配图已下载";
      return;
    }
    await copyText(work.body);
    const updated = await operatorApi(`/api/content/works/${encodeURIComponent(work.id)}/copied`, { method: "POST", body: "{}" });
    statusNode.textContent = "正文已复制；这次采纳已记入协作成员经历";
    works = works.map((item) => item.id === updated.id ? updated : item);
    await membersFeature.loadDossiers();
  } catch (error) {
    statusNode.classList.add("error");
    statusNode.textContent = `复制失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function watchWork(id) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const work = await operatorApi(`/api/content/works/${encodeURIComponent(id)}`);
    const index = works.findIndex((item) => item.id === id);
    if (index >= 0) works[index] = work;
    else works.unshift(work);
    renderWorks();
    const illustrationActive = ["pending", "briefing", "generating", "reviewing"].includes(work.illustration?.status);
    if (["ready", "failed"].includes(work.status) && !illustrationActive) {
      $("content-create-status").textContent = work.status === "ready"
        ? work.illustration?.status === "ready" ? "文字与配图均已通过，作品可复制和下载" : "文字已通过；配图未通过，可在作品卡中重试"
        : `创作未通过：${work.error}`;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  $("content-create-status").textContent = "创作仍在后台进行，可稍后刷新查看";
}
