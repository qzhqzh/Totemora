export const $ = (id) => document.getElementById(id);

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[char]);
}

export function externalLink(value, label) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") return escapeHtml(label);
    return `<a href="${escapeHtml(url.toString())}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  } catch {
    return escapeHtml(label);
  }
}

export function formatObservatoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export async function copyText(value) {
  if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(value);
  const node = document.createElement("textarea");
  node.value = value;
  node.setAttribute("readonly", "");
  node.style.position = "fixed";
  node.style.opacity = "0";
  document.body.appendChild(node);
  node.select();
  const copied = document.execCommand("copy");
  node.remove();
  if (!copied) throw new Error("浏览器拒绝剪贴板访问，请手动选择正文复制");
}
