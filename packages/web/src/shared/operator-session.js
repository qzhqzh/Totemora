import { features, skillsRoute } from "./app-context.js";
import { $ } from "./dom.js";

let authenticated = false;
let revision = 0;

export const operatorSession = {
  get authenticated() {
    return authenticated;
  },
  get revision() {
    return revision;
  },
};

export function initializeOperatorSession() {
  $("operator-token").value = sessionStorage.getItem("totemora_operator_token") || "";
  $("operator-login-open").addEventListener("click", openOperatorDialog);
  $("operator-dialog-close").addEventListener("click", () => $("operator-dialog").close());
  $("operator-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void validateOperatorSession({ closeOnSuccess: true });
  });
  $("operator-logout").addEventListener("click", () => {
    invalidateOperatorSession("已退出登录；受保护操作已锁定。");
    setOperatorAuthState("anonymous", "已退出登录；受保护操作已锁定。");
    void refreshProtectedViews();
  });
  $("operator-token").addEventListener("input", () => {
    sessionStorage.removeItem("totemora_operator_token");
    if (authenticated) invalidateOperatorSession("Token 已更改，验证后才会重新解锁。", { clearInput: false });
    else setOperatorAuthState("anonymous", "验证新 Token 后才会保存。");
  });
  if ($("operator-token").value.trim()) void validateOperatorSession();
}

export function openOperatorDialog() {
  setOperatorAuthState(authenticated ? "authenticated" : "anonymous");
  $("operator-dialog").showModal();
  window.setTimeout(() => $("operator-token").focus(), 0);
}

export async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function operatorApi(url, options = {}) {
  const token = $("operator-token").value.trim();
  const requestRevision = revision;
  if (!token) throw new Error("请输入操作员 Token");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  try {
    const result = await api(url, { ...options, headers });
    if (!authenticated || requestRevision !== revision) throw new Error("操作员登录状态已变化，请重试");
    return result;
  } catch (error) {
    if (error.status === 401) invalidateOperatorSession("Token 已失效，请重新登录。");
    throw error;
  }
}

export async function operatorFetch(url, options = {}) {
  const token = $("operator-token").value.trim();
  const requestRevision = revision;
  if (!token) throw new Error("请输入操作员 Token");
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (await response.json()).error || message;
    } catch {}
    if (response.status === 401) invalidateOperatorSession("Token 已失效，请重新登录。");
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  const protectedResponse = { response, revision: requestRevision, token };
  assertOperatorSession(protectedResponse);
  return protectedResponse;
}

export function assertOperatorSession(protectedResponse) {
  if (!authenticated
    || protectedResponse.revision !== revision
    || protectedResponse.token !== $("operator-token").value.trim()) {
    throw new Error("操作员登录状态已变化，请重试");
  }
}

export function invalidateOperatorSession(message, { clearInput = true } = {}) {
  revision += 1;
  sessionStorage.removeItem("totemora_operator_token");
  authenticated = false;
  if (clearInput) $("operator-token").value = "";
  for (const feature of Object.values(features)) feature.lockProtected?.();
  setOperatorAuthState("invalid", message);
}

async function validateOperatorSession({ closeOnSuccess = false } = {}) {
  const submit = $("operator-login-submit");
  const candidateToken = $("operator-token").value.trim();
  submit.disabled = true;
  $("operator-login-status").className = "operator-login-status";
  $("operator-login-status").textContent = "正在向服务器验证…";
  try {
    if (!candidateToken) throw new Error("请输入操作员 Token");
    await api("/api/operator/session", { headers: { authorization: `Bearer ${candidateToken}` } });
    if ($("operator-token").value.trim() !== candidateToken) throw new Error("Token 已更改，请重新验证");
    sessionStorage.setItem("totemora_operator_token", candidateToken);
    revision += 1;
    setOperatorAuthState("authenticated");
    await refreshProtectedViews();
    if (closeOnSuccess) $("operator-dialog").close();
    return true;
  } catch (error) {
    invalidateOperatorSession(error.status === 401
      ? "Token 不正确，请从服务器的 .totemora/operator-token 重新复制。"
      : error.message);
    return false;
  } finally {
    submit.disabled = false;
  }
}

async function refreshProtectedViews() {
  for (const feature of Object.values(features)) feature.releaseProtectedResources?.();
  if (!authenticated) features.development?.lockProtected?.();
  if (skillsRoute) {
    void features.skills?.loadCommissions();
    features.skills?.refreshSelected();
    return;
  }
  for (const feature of Object.values(features)) feature.refreshProtected?.();
}

function setOperatorAuthState(state, message) {
  authenticated = state === "authenticated";
  $("operator-login-open").classList.toggle("authenticated", authenticated);
  $("operator-auth-state").textContent = authenticated ? "已认证" : state === "invalid" ? "认证失败" : "未登录";
  $("operator-login-label").textContent = authenticated ? "操作员账户" : "操作员登录";
  $("operator-logout").classList.toggle("hidden", !authenticated);
  $("operator-login-status").className = `operator-login-status${state === "authenticated" ? " success" : state === "invalid" ? " error" : ""}`;
  $("operator-login-status").textContent = message ?? (authenticated
    ? "Token 已通过服务器验证，仅保存在当前标签页。"
    : "Token 仅保存在当前浏览器标签页。");
}
