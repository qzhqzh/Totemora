import { $ } from "./dom.js";

let pending;

$("delete-confirm-input").addEventListener("input", updateState);
$("delete-confirm-dialog-close").addEventListener("click", () => settle(false));
$("delete-confirm-cancel").addEventListener("click", () => settle(false));
$("delete-confirm-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  settle(false);
});
$("delete-confirm-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if ($("delete-confirm-input").value.trim() === pending?.name) settle(true);
});

export function confirmNamedDeletion({ kind, name }) {
  if (pending) pending.resolve(false);
  $("delete-confirm-dialog-title").textContent = `删除${kind}`;
  $("delete-confirm-prompt-msg").textContent = `该操作将永久删除此${kind}。为防止误删，请输入完整名称进行确认：`;
  $("delete-confirm-target-name").textContent = name;
  $("delete-confirm-input").value = "";
  $("delete-confirm-status").className = "operator-login-status";
  $("delete-confirm-status").textContent = "输入完全一致后方可确认删除。";
  $("delete-confirm-submit").disabled = true;
  $("delete-confirm-dialog").showModal();
  window.setTimeout(() => $("delete-confirm-input").focus(), 0);
  return new Promise((resolve) => {
    pending = { name, resolve };
  });
}

function updateState() {
  const matches = $("delete-confirm-input").value.trim() === pending?.name;
  $("delete-confirm-submit").disabled = !matches;
  $("delete-confirm-status").className = `operator-login-status${matches ? " success" : ""}`;
  $("delete-confirm-status").textContent = matches
    ? "名称已匹配，点击确认删除即可永久移除。"
    : "输入完全一致后方可确认删除。";
}

function settle(result) {
  if (!$("delete-confirm-dialog").open) return;
  $("delete-confirm-dialog").close();
  const current = pending;
  pending = undefined;
  current?.resolve(result);
}
