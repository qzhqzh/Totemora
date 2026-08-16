import { state } from "../shared/app-context.js";

export function memberLabel(id) {
  const member = state.tribe?.members.find((candidate) => candidate.id === id);
  return member ? `${member.name} / ${id}` : id;
}

export function registryStatusLabel(status) {
  return ({ active: "已装备", candidate: "候选", warning: "需关注", invalid: "不可用" })[status] || status;
}

export function validationStatusLabel(status) {
  return ({ passed: "验证通过", warning: "验证有提醒", failed: "验证未通过" })[status] || status;
}

export function fileKindLabel(kind) {
  return ({ manifest: "SKILL", metadata: "治理", script: "脚本", reference: "参考", asset: "资产", agent: "宿主", other: "其他" })[kind] || kind;
}

export function formatFileSize(value) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
}

export function trialStageLabel(stage) {
  return ({
    queued: "等待成员",
    baseline: "运行无新 Skill 基线",
    trial: "运行固定版本试用",
    review: "独立测试成员验收",
    record: "Chief 登记证据",
    completed: "试炼已登记",
    failed: "试炼失败",
  })[stage] || stage;
}

export function skillStatusLabel(status) {
  return ({
    discovering: "澄清中",
    draft: "草案",
    trial: "试用中",
    activation_proposed: "等待装备审批",
    active: "已装备",
    superseded: "已被新版本取代",
    suspended: "已回滚",
    cancelled: "已取消",
  })[status] || status;
}
