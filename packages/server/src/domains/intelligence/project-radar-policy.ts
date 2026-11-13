import { createHash } from "node:crypto";
import type { IntelligenceCandidate } from "../../intelligence-candidate-store";
import type { ProjectRadarEvaluation, ProjectRadarProject, ProjectRadarSettings } from "./project-radar-types";

export const PROJECT_RADAR_QUESTION_VERSION = "project-radar-v1";
export const PROJECT_RADAR_MAX_PROJECTS = 8;
export function defaultProjectRadarSettings(now = new Date(0)): ProjectRadarSettings {
  return {
    version: 1, mode: "off", timezone: "Asia/Shanghai", digest_time: "19:30", digest_limit: 5,
    daily_evaluation_limit: 100, daily_token_limit: 50_000, updated_at: now.toISOString(),
    projects: [
      { id: "totemora", name: "Totemora", goal: "常驻跟进项目情报、生成有证据的行动建议，并通过多渠道传递消息和接收反馈",
        focus: ["MCP", "agent", "智能体", "notification", "通知通道", "模型评测", "evaluation", "推理成本", "上下文管理"], exclude: [], enabled: true },
      { id: "foundry-studio", name: "Foundry Studio", goal: "构建预览与导出共用页面规格的界面创作工具",
        focus: ["页面规格与代码导出", "组件库", "设计系统", "界面预览"], exclude: [], enabled: true },
    ],
  };
}

export function projectRadarSettingsFingerprint(settings: ProjectRadarSettings, model = "jev-latest"): string {
  const { updated_at: _timestamp, ...configuration } = settings;
  return createHash("sha256").update(JSON.stringify({ configuration, model, question_version: PROJECT_RADAR_QUESTION_VERSION })).digest("hex");
}

export function parseProjectRadarSettings(value: unknown, now = new Date()): ProjectRadarSettings {
  const input = object(value, "settings");
  const keys = ["version", "mode", "projects", "timezone", "digest_time", "digest_limit", "daily_evaluation_limit", "daily_token_limit", "updated_at"];
  if (Object.keys(input).some((key) => !keys.includes(key))) invalid("unknown settings field");
  if (input.version !== 1) invalid("version must be 1");
  if (!["off", "shadow", "active"].includes(String(input.mode))) invalid("invalid mode");
  if (input.timezone !== "Asia/Shanghai") invalid("timezone must be Asia/Shanghai");
  const time = string(input.digest_time, "digest_time", 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) invalid("digest_time must use HH:mm");
  if (!Array.isArray(input.projects) || input.projects.length < 1 || input.projects.length > PROJECT_RADAR_MAX_PROJECTS) invalid("projects must contain 1–8 cards");
  const projects = input.projects.map(parseProject);
  if (new Set(projects.map((project) => project.id)).size !== projects.length) invalid("duplicate project id");
  if (input.mode !== "off" && !projects.some((project) => project.enabled)) invalid("enabled mode requires an enabled project");
  if (input.updated_at !== undefined && (!Number.isFinite(Date.parse(string(input.updated_at, "updated_at", 40))))) invalid("invalid updated_at");
  return {
    version: 1, mode: input.mode as ProjectRadarSettings["mode"], projects, timezone: "Asia/Shanghai",
    digest_time: time, digest_limit: integer(input.digest_limit, "digest_limit", 1, 5),
    daily_evaluation_limit: integer(input.daily_evaluation_limit, "daily_evaluation_limit", 1, 500),
    daily_token_limit: integer(input.daily_token_limit, "daily_token_limit", 1_000, 250_000), updated_at: now.toISOString(),
  };
}

export function projectRadarRoute(input: {
  candidate: IntelligenceCandidate; has_evidence: boolean;
  projects: ProjectRadarEvaluation["projects"]; decision_confidence: number;
  evidence_quality: number; novelty: number; urgency: number; same_event: boolean;
}): Pick<ProjectRadarEvaluation, "route" | "reason"> {
  if (!input.has_evidence) return { route: "review", reason: "缺少与候选对应的原始采集证据" };
  if (input.decision_confidence < 0.65 || input.evidence_quality < 0.6) return { route: "review", reason: "判断信心或材料充分程度不足，需要核实" };
  if (input.candidate.scores.confidence < 0.55) return { route: "review", reason: "既有事实可信度门槛未通过" };
  if (input.candidate.domain === "finance" && (!input.candidate.evidence_tier || input.candidate.evidence_tier === "S4")) return { route: "review", reason: "财经来源证据门槛未通过" };
  if (input.candidate.duplicate_of || (input.same_event && (!input.candidate.is_update || input.novelty < 0.75))) return { route: "hold", reason: "同一事件未增加足够的新事实" };
  if (input.novelty < 0.55) return { route: "hold", reason: "新颖度不足" };
  const relevance = Math.max(0, ...input.projects.map((project) => project.relevance));
  if (relevance < 0.65) return { route: "hold", reason: "与启用项目的相关性不足" };
  if (relevance >= 0.85 && input.urgency >= 0.85 && input.evidence_quality >= 0.8) return { route: "immediate", reason: "项目相关性和时效性高，建议优先关注" };
  return { route: "digest", reason: "与项目相关，适合每日精选" };
}

export function projectRadarDay(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}
function parseProject(value: unknown): ProjectRadarProject {
  const item = object(value, "project");
  if (Object.keys(item).some((key) => !["id", "name", "goal", "focus", "exclude", "enabled"].includes(key))) invalid("unknown project field");
  const id = string(item.id, "project.id", 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) invalid("invalid project.id");
  if (typeof item.enabled !== "boolean") invalid("project.enabled must be boolean");
  return { id, name: string(item.name, "project.name", 100), goal: string(item.goal, "project.goal", 1_000),
    focus: strings(item.focus, "project.focus", 1), exclude: strings(item.exclude, "project.exclude", 0), enabled: item.enabled };
}
function strings(value: unknown, name: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 20) invalid(`${name} must contain ${minimum}–20 entries`);
  return value.map((item) => string(item, name, 200));
}
function string(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`invalid ${name}`);
  return value.trim();
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${name} must be ${min}–${max}`);
  return value;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function invalid(message: string): never { throw new Error(`Invalid project radar settings: ${message}`); }
