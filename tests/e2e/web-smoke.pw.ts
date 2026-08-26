import { expect, test } from "@playwright/test";

test("app renders, opens the operator gate, and navigates to Skills", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.goto("/");
  await expect(page).toHaveTitle("铁锅部落");
  await expect(page.getByRole("heading", { name: "部落证据台" })).toBeVisible();
  await expect(page.locator("#tribe-status")).toContainText("0.12.0");

  await page.getByRole("button", { name: /操作员登录/ }).click();
  await expect(page.getByRole("dialog", { name: "操作员登录" })).toBeVisible();
  await expect(page.locator("#operator-login-status")).toContainText("当前浏览器标签页");
  await page.getByRole("button", { name: "关闭登录窗口" }).click();

  await page.getByRole("link", { name: "能力", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/skills" && url.searchParams.get("tab") === "prompt");
  await expect(page).toHaveTitle("能力 · 铁锅部落");
  await expect(page.getByRole("heading", { name: "能力库" })).toBeVisible();
  await expect(page.locator("#skill-registry-list")).not.toContainText("正在读取仓库 Skill");

  expect(runtimeErrors).toEqual([]);
});
