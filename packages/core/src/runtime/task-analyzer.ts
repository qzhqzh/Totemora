import type { TaskAnalysis, TaskMode, TribeTask } from "./types";

export interface TaskIntentInput {
  goal: string;
  has_workspace: boolean;
  continuing?: boolean;
  onboarding?: boolean;
}

const OPERATE_PATTERNS = [/部署|发布|重启|启动服务|执行测试|运行测试|shell|命令|数据库迁移/i];
const CHANGE_PATTERNS = [/修改|修复|实现|开发|编码|coding|写代码|重构|删除|新增文件|改一下|提交当前|提交改动|git commit|commit changes/i];
const INSPECT_PATTERNS = [/分析|检查|审查|评估|阅读|总结|找出|诊断|review/i];

export function analyzeTaskIntent(input: TaskIntentInput): TaskAnalysis {
  if (input.onboarding) return result("onboarding", ["structured_output", "delegation"], ["reasoning", "review"], true, "系统入门考核任务");
  if (OPERATE_PATTERNS.some((pattern) => pattern.test(input.goal))) return result("operate", ["external_effect", "approval_required"], ["tool_use", "reliability"], false, "目标包含运行、部署或外部操作意图");
  if (CHANGE_PATTERNS.some((pattern) => pattern.test(input.goal))) return result("change", ["workspace_write", "approval_required", "rollback_required"], ["coding", "reasoning", "reliability"], false, "目标包含代码或文件变更意图");
  if (input.continuing) return result("continue", ["mission_context", input.has_workspace ? "workspace_evidence" : "conversation"], ["context", "reasoning"], input.has_workspace, "用户选择继续已有 Mission");
  if (input.has_workspace || INSPECT_PATTERNS.some((pattern) => pattern.test(input.goal))) return result("inspect", ["workspace_evidence", "read_only", "explicit_acceptance"], ["reading", "reasoning", "review"], input.has_workspace, "目标需要读取工作地并提供证据");
  return result("answer", ["conversation"], ["reasoning"], false, "目标可以通过直接讨论处理");
}

export function analyzeTribeTask(task: TribeTask): TaskAnalysis {
  return analyzeTaskIntent({
    goal: task.goal,
    has_workspace: Boolean(task.workspace?.files.length),
    continuing: task.context?.some((item) => item.includes("同一 Mission")),
    onboarding: task.id === "onboarding_exam_v1",
  });
}

function result(type: TaskMode, features: string[], requiredCapabilities: string[], executionEnabled: boolean, reason: string): TaskAnalysis {
  return { type, features, required_capabilities: requiredCapabilities, execution_enabled: executionEnabled, reason };
}
