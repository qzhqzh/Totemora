import { expect, test, type Page } from "@playwright/test";

const token = process.env.TOTEMORA_E2E_OPERATOR_TOKEN ?? "totemora-e2e-operator-token";
const endpoint = "/api/intelligence/radar";
const mockSettings = {
  version: 1, mode: "shadow", timezone: "Asia/Shanghai", digest_time: "19:30", digest_limit: 5,
  daily_evaluation_limit: 100, daily_token_limit: 50000, updated_at: "2026-09-22T09:00:00.000Z",
  projects: [
    { id: "totemora", name: "Totemora", goal: "离线测试：项目情报与证据", focus: ["多 Agent"], exclude: [], enabled: true },
    { id: "foundry-studio", name: "Foundry Studio", goal: "离线测试：页面导出", focus: ["设计系统"], exclude: [], enabled: true },
  ],
};
const mockEvaluation = {
  id: "radar-evaluation-fixture", candidate_id: "radar-candidate-fixture",
  headline: "离线样例：项目情报证据链", url: "https://example.com/radar-fixture", brief: "用于界面验证的模拟消息，不代表真实 Jev 效果。",
  baseline: { scores: { total: 0.72 }, status: "held" },
  projects: [{ project_id: "totemora", relevance: 0.9, confidence: 0.82 }],
  route: "digest", decision_confidence: 0.82, reason: "离线样例：与项目目标相关",
  created_at: "2026-09-22T09:00:00.000Z",
};

const mockRuleEvaluation = {
  ...mockEvaluation, id: "radar-rules-fixture", evaluation_method: "rules", decision_confidence: null,
  projects: [{ project_id: "totemora", relevance: 0.9, confidence: null }],
};

function actionFixture(id: string, status = "proposed") {
  return { id, status, title: `验证项目情报建议 ${id}`, project_id: "totemora", project_name: "Totemora",
    candidate_id: mockRuleEvaluation.candidate_id, evaluation_id: mockRuleEvaluation.id,
    rationale: "这项变化直接影响项目当前目标。", next_step: "对现有流程做一次有证据的小范围验证。",
    acceptance_criteria: ["记录验证结果与来源证据。"],
    evidence: [{ title: "原始发布说明", url: "https://example.com/evidence", source: "官方发布", text: "离线测试证据" }],
    method: "rules", created_at: "2026-10-25T09:00:00.000Z" };
}

function handoffFixture(action: ReturnType<typeof actionFixture>) {
  return { destination: "lifeline", status: "draft", submitted: false, ready: false,
    title: action.title, project_id: null, phase_id: null, missing_fields: ["project_id", "phase_id"],
    source: { action_id: action.id, candidate_id: action.candidate_id, evaluation_id: action.evaluation_id },
    evidence: action.evidence };
}

async function login(page: Page) {
  await page.locator("#operator-login-open").click();
  await page.locator("#operator-token").fill(token);
  await page.getByRole("button", { name: "验证并登录" }).click();
  await expect(page.locator("#operator-auth-state")).toHaveText("已认证");
  await expect(page.locator("#operator-dialog")).not.toBeVisible();
}

async function installRadarFixtures(page: Page, options: { rules?: boolean; actions?: ReturnType<typeof actionFixture>[] } = {}) {
  await page.route(`**${endpoint}`, (route) => route.fulfill({ json: {
    settings: mockSettings, configured: !options.rules, model: "fixture-model-offline-only",
    baseline_available: true, evaluation_method: options.rules ? "rules" : "jev",
    evaluations: [options.rules ? mockRuleEvaluation : mockEvaluation],
    usage: { day: "2026-09-22", evaluations: options.rules ? 0 : 1, rules_evaluations: options.rules ? 1 : 0,
      input_tokens: options.rules ? 0 : 120, failures: 0, pending: 0 }, feedback: {},
  } }));
  await page.route(`**${endpoint}/actions`, (route) => route.fulfill({ json: { actions: options.actions || [] } }));
  await page.route(`**${endpoint}/digest`, (route) => route.fulfill({ json: {
    date: "2026-09-22", status: "preview", items: [{
      candidate_id: mockEvaluation.candidate_id, headline: mockEvaluation.headline, brief: mockEvaluation.brief,
      url: mockEvaluation.url, project_names: ["Totemora"], reason: mockEvaluation.reason, evaluation_id: mockEvaluation.id,
    }],
  } }));
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

function watchRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("status of 503")) errors.push(message.text());
  });
  return errors;
}

test("radar enables, evaluates and saves the real rules baseline without a Jev key", async ({ page }) => {
  const headers = { authorization: `Bearer ${token}` };
  const original = await (await page.request.get(endpoint, { headers })).json();
  try {
    const runtimeErrors = watchRuntimeErrors(page);
    let evaluations = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname === `${endpoint}/evaluate`) evaluations += 1; });
    await page.goto("/#project-radar-panel");
    await expect(page).toHaveTitle("铁锅部落");
    await expect(page).toHaveURL(/#project-radar-panel$/);
    const panel = page.locator("#project-radar-panel");
    await expect(panel.getByRole("button", { name: "操作员登录", exact: true })).toBeVisible();
    await expect(panel.locator("form")).toHaveCount(0);
    await expect(panel).not.toContainText("Foundry Studio");
    await expectNoOverflow(page);
    await login(page);
    await expect(panel).toContainText("规则基线可用");
    await expect(panel).toContainText("不消耗模型 Token");
    await expect(panel.locator('[name="mode"]')).toHaveValue("off");
    await expect(panel.locator('option[value="shadow"]')).toHaveJSProperty("disabled", false);
    await expect(panel.locator('option[value="active"]')).toHaveJSProperty("disabled", false);
    await expect(panel.getByRole("button", { name: "评估最近 10 条候选" })).toBeDisabled();
    const goal = panel.locator('[name="project_0_goal"]');
    const originalGoal = await goal.inputValue();
    const updatedGoal = "离线浏览器验收：保存项目关注目标并刷新确认";
    await goal.fill(updatedGoal);
    await panel.locator('[name="mode"]').selectOption("shadow");
    await page.route(`**${endpoint}/settings`, (route) => route.fulfill({ status: 503, json: { error: "离线测试：保存暂不可用" } }));
    await panel.getByRole("button", { name: "保存项目雷达设置" }).click();
    await expect(page.locator("#project-radar-status")).toContainText("操作失败");
    await expect(goal).toHaveValue(updatedGoal);
    await expect(panel.getByRole("button", { name: "评估最近 10 条候选" })).toBeDisabled();
    await expect(panel.locator('[name="mode"]')).toHaveValue("shadow");
    await page.unroute(`**${endpoint}/settings`);
    await panel.getByRole("button", { name: "保存项目雷达设置" }).click();
    await expect(page.locator("#project-radar-status")).toContainText("设置已保存");
    await expect(panel.getByRole("button", { name: "评估最近 10 条候选" })).toBeEnabled();
    const evaluationResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `${endpoint}/evaluate`);
    await panel.getByRole("button", { name: "评估最近 10 条候选" }).click();
    expect((await evaluationResponse).status()).toBe(200);
    await expect(page.locator("#project-radar-status")).toContainText("评估完成");
    const current = await page.request.get(endpoint, { headers: { authorization: `Bearer ${token}` } });
    expect(await current.json()).toMatchObject({ configured: false, baseline_available: true, evaluation_method: "rules" });
    await panel.locator('[name="mode"]').selectOption("active");
    await panel.getByRole("button", { name: "保存项目雷达设置" }).click();
    await expect(page.locator("#project-radar-status")).toContainText("设置已保存");
    await page.reload();
    await expect(page.locator("#operator-auth-state")).toHaveText("已认证");
    await expect(goal).toHaveValue(updatedGoal);
    await expect(panel.locator('[name="mode"]')).toHaveValue("active");
    await expectNoOverflow(page);
    await goal.fill(originalGoal);
    await panel.locator('[name="mode"]').selectOption("off");
    await panel.getByRole("button", { name: "保存项目雷达设置" }).click();
    await expect(page.locator("#project-radar-status")).toContainText("设置已保存");
    await panel.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: test.info().outputPath("radar-viewport.png") });
    await panel.screenshot({ path: test.info().outputPath("radar-unconfigured.png") });
    expect(evaluations).toBe(1);
    expect(runtimeErrors).toEqual([]);
  } finally {
    if (original.settings) await page.request.put(`${endpoint}/settings`, { headers, data: original.settings });
  }
});

test("offline radar comparison supports explicit evaluation and feedback failure retry", async ({ page }) => {
  const runtimeErrors = watchRuntimeErrors(page);
  await installRadarFixtures(page);
  let releaseEvaluation!: () => void;
  const evaluationGate = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
  let evaluations = 0;
  await page.route(`**${endpoint}/evaluate`, async (route) => {
    evaluations += 1;
    expect(route.request().postDataJSON()).toEqual({ limit: 10 });
    await evaluationGate;
    await route.fulfill({ json: { evaluated: 1, cached: 0, failed: 0, skipped: 0, budget_exhausted: false } });
  });
  let feedbackAttempts = 0;
  await page.route(`**/api/intelligence/candidates/${mockEvaluation.candidate_id}/feedback`, async (route) => {
    feedbackAttempts += 1;
    expect(route.request().postDataJSON()).toEqual({ signal: "valuable" });
    await route.fulfill(feedbackAttempts === 1
      ? { status: 503, json: { error: "离线测试：反馈暂不可用" } }
      : { json: { inserted: true } });
  });
  await page.goto("/#project-radar-panel");
  await login(page);
  const panel = page.locator("#project-radar-panel");
  await expect(panel).toContainText("fixture-model-offline-only");
  await panel.locator("summary").click();
  await expect(panel).toContainText("原有评分 72%");
  await expect(panel).toContainText("相关性 90%");
  await expect(panel).toContainText("判断信心 82%");
  expect(evaluations).toBe(0);
  const evaluate = panel.getByRole("button", { name: "评估最近 10 条候选" });
  await evaluate.click();
  await expect(evaluate).toBeDisabled();
  await expect.poll(() => evaluations).toBe(1);
  releaseEvaluation();
  await expect(page.locator("#project-radar-status")).toContainText("新增 1 条");
  await expect(evaluate).toBeEnabled();
  const card = panel.locator("[data-radar-candidate]").first();
  await card.getByRole("button", { name: "有价值", exact: true }).click();
  await expect(card.locator(".feedback-status")).toContainText("反馈失败");
  await expect(card.getByRole("button", { name: "有价值", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "有价值", exact: true }).click();
  await expect(card.locator(".feedback-status")).toContainText("反馈已记录");
  expect(feedbackAttempts).toBe(2);
  await panel.locator("summary").click();
  await expectNoOverflow(page);
  await panel.screenshot({ path: test.info().outputPath("radar-offline-comparison.png") });
  expect(runtimeErrors).toEqual([]);
});

test("radar logout clears project data and ignores an earlier protected response", async ({ page }) => {
  await installRadarFixtures(page);
  await page.goto("/#project-radar-panel");
  await login(page);
  const panel = page.locator("#project-radar-panel");
  await expect(panel).toContainText("fixture-model-offline-only");
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let requested = false;
  await page.route(`**${endpoint}`, async (route) => {
    requested = true;
    await responseGate;
    await route.fulfill({ json: {
      settings: mockSettings, configured: true, model: "late-protected-response", evaluations: [mockEvaluation], usage: {}, feedback: {},
    } });
  });
  await panel.getByRole("button", { name: "刷新结果" }).click();
  await expect.poll(() => requested).toBe(true);
  await page.locator("#operator-login-open").click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.locator("#operator-auth-state")).toHaveText("未登录");
  await expect(panel.locator("form")).toHaveCount(0);
  const response = page.waitForResponse((result) => new URL(result.url()).pathname === endpoint);
  releaseResponse();
  await response;
  await expect(panel).not.toContainText("late-protected-response");
  await expect(panel).not.toContainText("Foundry Studio");
  await page.getByRole("button", { name: "关闭登录窗口" }).click();
  await expect(panel.getByRole("button", { name: "操作员登录", exact: true })).toBeVisible();
  await expectNoOverflow(page);
});

test("an older running gateway still shows radar settings without requesting the new action API", async ({ page }) => {
  const runtimeErrors = watchRuntimeErrors(page);
  await installRadarFixtures(page);
  await page.route(`**${endpoint}`, (route) => route.fulfill({ json: {
    settings: mockSettings, configured: false, model: "jev-latest", evaluations: [], usage: {}, feedback: {},
  } }));
  let actionRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === `${endpoint}/actions`) actionRequests++; });
  await page.goto("/#project-radar-panel");
  await login(page);
  const panel = page.locator("#project-radar-panel");
  await expect(panel.locator("#project-radar-settings")).toBeVisible();
  await expect(panel).toContainText("当前服务尚不支持行动建议");
  expect(actionRequests).toBe(0);
  expect(runtimeErrors).toEqual([]);
});

test("source panels preserve upstream failures and show the next probe instead of claiming recovery", async ({ page }) => {
  const runtimeErrors = watchRuntimeErrors(page);
  await page.route("**/api/deals/status", (route) => route.fulfill({ json: {
    counts: {}, latest_source_run: { status: "error" },
    source_health: { status: "blocked", error: "来源要求访问验证", retry_after: "2026-10-25T12:00:00Z" },
  } }));
  await page.route("**/api/forwarded/status", (route) => route.fulfill({ json: {
    configured: true, counts: {}, source: { last_error: "上游 TLS 握手失败" },
    polling: { failure_kind: "tls", next_poll_at: "2026-10-25T12:05:00Z" },
  } }));
  await page.goto("/#deals");
  await login(page);
  await expect(page.locator("#deal-health")).toContainText("来源受阻");
  await expect(page.locator("#deal-health")).toContainText("来源要求访问验证");
  await expect(page.locator("#deal-health")).toContainText("下次探测");
  await expect(page.locator("#forwarded-health")).toContainText("等待重试");
  await expect(page.locator("#forwarded-health")).toContainText("上游 TLS 握手失败");
  await expect(page.locator("#forwarded-health")).toContainText("下次探测");
  await expectNoOverflow(page);
  await page.locator("#deals").screenshot({ path: test.info().outputPath("deals-source-blocked.png") });
  await page.locator("#forwarded").screenshot({ path: test.info().outputPath("forwarded-source-backoff.png") });
  expect(runtimeErrors).toEqual([]);
});

test("rules suggestions retain an idempotent decision on retry and expose an unsubmitted handoff", async ({ page, context }) => {
  const runtimeErrors = watchRuntimeErrors(page);
  const actions = [actionFixture("action-accept"), actionFixture("action-dismiss")];
  await installRadarFixtures(page, { rules: true, actions });
  const acceptKeys: string[] = [];
  await page.route(`**${endpoint}/actions/action-accept/decision`, async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON();
    expect(body.decision).toBe("accept");
    expect(body.idempotency_key).toMatch(/^radar:[a-f0-9]{32}$/);
    acceptKeys.push(body.idempotency_key);
    if (acceptKeys.length === 1) return route.fulfill({ status: 503, json: { error: "离线测试：采纳响应暂不可用" } });
    actions[0].status = "accepted";
    await route.fulfill({ json: actions[0] });
  });
  await page.route(`**${endpoint}/actions/action-dismiss/decision`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ decision: "dismiss" });
    actions[1].status = "dismissed";
    await route.fulfill({ json: actions[1] });
  });
  const draft = handoffFixture(actions[0]);
  await page.route(`**${endpoint}/actions/action-accept/handoff`, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: draft });
  });
  const unexpectedSubmissions: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /lifeline|handoff/.test(new URL(request.url()).pathname)) unexpectedSubmissions.push(request.url());
  });
  await page.goto("/#project-radar-panel");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await login(page);
  const panel = page.locator("#project-radar-panel");
  await expect(panel).toContainText("规则基线可用");
  await expect(panel).toContainText("今日规则评估 1 条 · 模型评估 0 条");
  await panel.locator("summary").click();
  const comparison = panel.locator("details [data-radar-candidate]");
  await expect(comparison).toContainText("规则匹配");
  await expect(comparison).toContainText("不提供模型信心");
  await expect(comparison).not.toContainText("判断信心 0%");
  const accepted = panel.locator('[data-radar-suggestion="action-accept"]');
  await expect(accepted).toContainText("验收依据");
  await expect(accepted.getByRole("link", { name: "原始发布说明" })).toHaveAttribute("href", "https://example.com/evidence");
  await accepted.getByRole("button", { name: "采纳建议" }).click();
  await expect(page.locator("#project-radar-status")).toContainText("操作失败");
  await expect(accepted).toContainText("待审核");
  await accepted.getByRole("button", { name: "采纳建议" }).click();
  await expect(accepted).toContainText("已采纳 · 待交接");
  expect(acceptKeys).toHaveLength(2);
  expect(acceptKeys[0]).toBe(acceptKeys[1]);
  await expect(accepted.getByRole("button", { name: "采纳建议" })).toHaveCount(0);
  await accepted.getByRole("button", { name: "查看交接草稿" }).click();
  await expect(accepted.locator("[data-radar-draft]")).toContainText("尚未提交到 Lifeline");
  expect(JSON.parse(await accepted.locator("[data-radar-handoff-json]").inputValue())).toEqual(draft);
  await accepted.getByRole("button", { name: "复制交接草稿" }).click();
  await expect(page.locator("#project-radar-status")).toContainText("交接草稿已复制");
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(draft);
  const dismissed = panel.locator('[data-radar-suggestion="action-dismiss"]');
  await dismissed.getByRole("button", { name: "忽略建议" }).click();
  await expect(dismissed).toContainText("已忽略");
  await expect(dismissed.getByRole("button", { name: "查看交接草稿" })).toHaveCount(0);
  await expectNoOverflow(page);
  await accepted.screenshot({ path: test.info().outputPath("radar-action-handoff.png") });
  expect(unexpectedSubmissions).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("logout clears action drafts and rejects a handoff response from the previous session", async ({ page }) => {
  const actions = [actionFixture("action-private", "accepted")];
  await installRadarFixtures(page, { rules: true, actions });
  let releaseHandoff!: () => void;
  const gate = new Promise<void>((resolve) => { releaseHandoff = resolve; });
  let requested = false;
  await page.route(`**${endpoint}/actions/action-private/handoff`, async (route) => {
    requested = true;
    await gate;
    await route.fulfill({ json: { ...handoffFixture(actions[0]), title: "previous-session-private-draft" } });
  });
  await page.goto("/#project-radar-panel");
  await login(page);
  const panel = page.locator("#project-radar-panel");
  await panel.getByRole("button", { name: "查看交接草稿" }).click();
  await expect.poll(() => requested).toBe(true);
  await page.locator("#operator-login-open").click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(panel.locator("[data-radar-suggestion]")).toHaveCount(0);
  const response = page.waitForResponse((result) => new URL(result.url()).pathname.endsWith("/action-private/handoff"));
  releaseHandoff();
  await response;
  await expect(panel).not.toContainText("previous-session-private-draft");
  await page.getByRole("button", { name: "关闭登录窗口" }).click();
  await login(page);
  await expect(panel.getByRole("button", { name: "查看交接草稿" })).toBeVisible();
  await expect(panel.locator("[data-radar-draft]")).toHaveCount(0);
  await expect(panel).not.toContainText("previous-session-private-draft");
});
