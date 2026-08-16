export const skillsRoute = location.pathname === "/skills" || location.pathname === "/skills/";

export const phases = {
  queued: 8,
  planning: 25,
  executing: 55,
  reviewing: 78,
  repairing: 68,
  cancelling: 85,
  cancelled: 100,
  completed: 100,
  failed: 100,
};

export const state = {
  tribe: undefined,
  status: undefined,
  settlement: undefined,
};

export const features = {};

export function registerFeature(name, feature) {
  features[name] = feature;
  return feature;
}
