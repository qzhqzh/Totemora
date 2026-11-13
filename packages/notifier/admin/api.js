export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function request(path, options = {}) {
  const { method = "GET", body } = options;
  let response;
  try {
    response = await fetch(`/admin/api${path}`, {
      method, credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(method === "GET" ? "无法连接 Notifier，请检查服务状态。" :
      "网络结果未知；操作可能已经生效，请先刷新核对，勿盲目重试发送。", 0);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new ApiError("Notifier 返回了无法识别的响应。", response.status); }
  if (!response.ok) throw new ApiError(result.error || `请求失败（HTTP ${response.status}）`, response.status);
  return result;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function time(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short", timeStyle: "short", hour12: false,
  }).format(date);
}

export const DOMAINS = ["ops", "ai", "finance", "reminder", "deals", "forwarded", "content"];
export const DOMAIN_LABELS = { ops: "运维", ai: "AI", finance: "财经", reminder: "提醒",
  deals: "优惠", forwarded: "转发", content: "内容" };
