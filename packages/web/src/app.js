import { registerFeature, skillsRoute, state } from "./shared/app-context.js";
import { $, escapeHtml } from "./shared/dom.js";
import { api, initializeOperatorSession } from "./shared/operator-session.js";
import { abilityTemplatesFeature } from "./features/ability-templates.js";
import { contentStudioFeature } from "./features/content-studio.js";
import { developmentFeature } from "./features/development.js";
import { dealsFeature } from "./features/deals.js";
import { intelligenceFeature } from "./features/intelligence.js";
import { membersFeature } from "./features/members.js";
import { notificationsFeature } from "./features/notifications.js";
import { observatoryFeature } from "./features/observatory.js";
import { remindersFeature } from "./features/reminders.js";
import { runsFeature } from "./features/runs.js";
import { skillsFeature } from "./features/skills.js";
import "./features/skill-authoring.js";

document.body.classList.toggle("route-skills", skillsRoute);
document.title = skillsRoute ? "能力 · 铁锅部落" : "铁锅部落";
document.querySelectorAll("[data-primary-route]").forEach((link) => {
  const active = link.dataset.primaryRoute === (skillsRoute ? "skills" : "home");
  if (active) link.setAttribute("aria-current", "page");
  else link.removeAttribute("aria-current");
});

registerFeature("development", developmentFeature);
registerFeature("deals", dealsFeature);
registerFeature("intelligence", intelligenceFeature);
registerFeature("contentStudio", contentStudioFeature);
registerFeature("notifications", notificationsFeature);
registerFeature("observatory", observatoryFeature);
registerFeature("reminders", remindersFeature);
registerFeature("skills", skillsFeature);

runsFeature.configure({
  async onSettled() {
    await Promise.all([
      developmentFeature.loadHistory(),
      developmentFeature.loadSettlement(),
      membersFeature.loadDossiers(),
    ]);
  },
});
abilityTemplatesFeature.initializeRoute();
initializeOperatorSession();

if (skillsRoute) {
  void loadSkillsRoute();
} else {
  void loadHomeRoute();
  window.setInterval(() => {
    if (!document.hidden) void observatoryFeature.load({ quiet: true });
  }, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void observatoryFeature.load({ quiet: true });
  });
}

async function loadHomeRoute() {
  try {
    await loadTribeSummary();
    membersFeature.renderCodex();
    await Promise.all([
      membersFeature.loadEmbers(),
      membersFeature.loadAssets(),
      membersFeature.loadDossiers(),
      intelligenceFeature.loadIntelligence(),
      intelligenceFeature.loadIntelligencePreferences(),
      intelligenceFeature.loadFinance(),
      intelligenceFeature.loadFinancePreferences(),
      contentStudioFeature.load(),
      notificationsFeature.loadBarkTargets(),
      remindersFeature.loadReminders(),
      dealsFeature.loadDeals(),
      skillsFeature.loadCommissions(),
      skillsFeature.loadRegistry(),
      abilityTemplatesFeature.load(),
    ]);
    await observatoryFeature.load();
    $("chief").innerHTML = state.tribe.members
      .filter((member) => member.roles.includes("chief") && !["inactive", "retired"].includes(member.status))
      .map((member) => `<option value="${escapeHtml(member.id)}" ${member.id === state.tribe.tribe.chief ? "selected" : ""}>${escapeHtml(member.name)} · ${escapeHtml(member.model)}</option>`).join("");
    await Promise.all([
      developmentFeature.loadHistory(),
      developmentFeature.loadSettlement(),
      developmentFeature.loadDevelopmentHistory(),
    ]);
    await developmentFeature.analyzeIntake();
  } catch (error) {
    $("tribe-status").textContent = error.message;
    $("tribe-status").classList.add("error");
  }
}

async function loadSkillsRoute() {
  const registry = skillsFeature.loadRegistry();
  try {
    await Promise.all([loadTribeSummary(), loadSettlementSummary(), abilityTemplatesFeature.load()]);
    skillsFeature.refreshSelected();
  } catch {
    $("tribe-status").textContent = "能力控制面 · 部落状态暂不可用";
    $("tribe-status").classList.add("error");
  }
  await Promise.allSettled([registry, skillsFeature.loadCommissions()]);
}

async function loadTribeSummary() {
  const [tribe, status] = await Promise.all([api("/api/tribe"), api("/api/status")]);
  state.tribe = tribe;
  state.status = status;
  $("tribe-status").textContent = `${status.version} · ${tribe.tribe.name} · ${status.active_members} 名可用成员`;
  $("roster").innerHTML = tribe.members.map((member) => `
    <article class="member ${member.id === tribe.tribe.chief ? "chief" : ""}">
      <strong>${escapeHtml(member.name)} <small>v${member.version} · ${escapeHtml(member.status)}</small></strong>
      <p>${escapeHtml(member.model)} / ${escapeHtml(member.provider)}</p>
      <small>${member.skills.map(escapeHtml).join(" · ") || "暂无 Skill"}</small>
    </article>`).join("");
}

async function loadSettlementSummary() {
  state.settlement = await api("/api/settlement");
}
