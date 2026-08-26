import { skillsRoute } from "../shared/app-context.js";
import { $ } from "../shared/dom.js";
import { api } from "../shared/operator-session.js";
import { promptTemplatesFeature } from "./prompt-templates.js";
import { workflowTemplatesFeature } from "./workflow-templates.js";

let activeTab = "prompt";

document.querySelectorAll("[data-ability-tab]").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.abilityTab));
});

export const abilityTemplatesFeature = {
  async load() {
    const { prompts, workflows } = await api("/api/ability-templates");
    promptTemplatesFeature.setTemplates(prompts);
    workflowTemplatesFeature.setTemplates(workflows);
  },
  initializeRoute() {
    const requested = new URLSearchParams(location.search).get("tab") || "prompt";
    switchTab(["skill", "prompt", "workflow"].includes(requested) ? requested : "prompt");
  },
};

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll("[data-ability-tab]").forEach((button) => {
    const active = button.dataset.abilityTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".ability-tab-content").forEach((panel) => {
    const active = panel.id === `ability-tab-${tab}`;
    panel.classList.toggle("active", active);
    panel.classList.toggle("hidden", !active);
  });
  $("refresh-skill-registry").classList.toggle("hidden", tab !== "skill");
  $("create-skill-button").classList.toggle("hidden", tab !== "skill");
  if (skillsRoute) {
    const url = new URL(location.href);
    url.searchParams.set("tab", activeTab);
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
}
