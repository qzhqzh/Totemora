import { skillCommissionsFeature } from "./skill-commissions.js";
import { skillRegistryFeature } from "./skill-registry.js";

export const skillsFeature = {
  loadCommissions: skillCommissionsFeature.loadCommissions,
  loadRegistry: skillRegistryFeature.loadRegistry,
  refreshSelected: skillRegistryFeature.refreshSelected,
  refreshProtected() {
    skillCommissionsFeature.refreshProtected();
    skillRegistryFeature.refreshProtected();
  },
  lockProtected() {
    skillCommissionsFeature.lockProtected();
    skillRegistryFeature.lockProtected();
  },
};
