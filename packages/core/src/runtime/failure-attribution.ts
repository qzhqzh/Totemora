import type { FailureAttribution } from "./types";

export function attributeFailure(error: unknown): FailureAttribution {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled|aborted|AbortError/i.test(message)) return failure("cancelled", false, "user", "任务由用户取消");
  if (/token budget|max_tokens|output_tokens=.*(?:3000|6000)|no text content/i.test(message)) return failure("budget", true, "runtime", "模型输出预算耗尽或未生成可用文本");
  if (/Provider .*request failed|Missing API key|invalid JSON/i.test(message)) return failure("provider", true, "provider", "模型服务请求失败或响应异常");
  if (/staffing plan|assigned unknown|assigned unavailable|delegate/i.test(message)) return failure("staffing", true, "chief", "派工计划无效或成员不可用");
  if (/parse|report|finding|acceptance|exactly three/i.test(message)) return failure("output_validation", true, "chief", "模型输出未通过结构或验收校验");
  if (/Workspace|workspace|ENOENT|路径/i.test(message)) return failure("workspace", false, "user", "工作地不可用或缺少必要内容");
  return failure("unknown", false, "unknown", message.slice(0, 240));
}

function failure(
  category: FailureAttribution["category"], retryable: boolean,
  owner: FailureAttribution["owner"], summary: string,
): FailureAttribution {
  return { category, retryable, owner, summary };
}
