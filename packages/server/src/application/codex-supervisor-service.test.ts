import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexSupervisorService } from "./codex-supervisor-service";
import type { CodexAppServerClient, CodexThreadGoal, JsonObject } from "../integrations/codex-app-server-client";
import { SettlementStore } from "../settlement-store";

test("managed goal runs through align, execution, verification, and completion", async () => {
  const fixture = await serviceFixture();
  try {
    await fixture.service.scan();
    const observed = fixture.service.listThreads()[0]!;
    const managed = await fixture.service.manageThread({
      thread_id: observed.thread_id,
      expected_revision: observed.revision,
      objective: "finish the supervised feature",
    });
    expect(managed).toMatchObject({ mode: "managed", phase: "aligning", token_budget: 150_000 });
    expect(managed.goal_status).toBeUndefined();

    await fixture.service.cycle();
    expect(fixture.service.getThread(observed.thread_id).thread).toMatchObject({
      phase: "executing", current_turn_id: "turn-1", last_turn_status: "inProgress",
    });
    expect(fixture.client.started).toHaveLength(1);
    const configuredResume = fixture.client.resumes.find((resume) => resume.config);
    const config = configuredResume?.config as JsonObject;
    const mcpServers = config.mcp_servers as JsonObject;
    const supervisor = mcpServers.totemora_supervisor as JsonObject;
    const authorization = supervisor.http_headers as JsonObject;
    const capabilityToken = String(authorization.Authorization).replace(/^Bearer /, "");
    expect(fixture.service.authorizeAgentToken(capabilityToken)).toBe(true);
    expect(fixture.service.reportAgentCheckpoint(capabilityToken, {
      summary: "implementation step complete", evidence: ["targeted tests passed"],
      remaining_work: ["verification"], outcome: "progress",
    }).status).toBe("resolved");

    fixture.goal = {
      objective: "finish the supervised feature", status: "complete", tokenBudget: 150_000,
    };
    fixture.service.handleNotification({
      method: "thread/goal/updated",
      params: { threadId: observed.thread_id, goal: { ...fixture.goal, tokensUsed: 100 } },
    }, "connection-1");
    fixture.service.handleNotification({
      method: "turn/completed",
      params: { threadId: observed.thread_id, turn: { id: "turn-1", status: "completed" } },
    }, "connection-1");
    await fixture.service.cycle();
    expect(fixture.service.getThread(observed.thread_id).thread).toMatchObject({
      phase: "verifying", current_turn_id: "turn-2",
    });
    expect(fixture.client.started[1]?.text).toContain("independent verification");

    fixture.service.handleNotification({
      method: "turn/completed",
      params: { threadId: observed.thread_id, turn: { id: "turn-2", status: "completed" } },
    }, "connection-1");
    await fixture.service.cycle();
    expect(fixture.service.getThread(observed.thread_id).thread).toMatchObject({
      phase: "completed", current_turn_id: undefined,
    });
    expect(fixture.client.interrupts).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("paginated history remains observable but cannot enter managed mode", async () => {
  const fixture = await serviceFixture({ historyMode: "paginated" });
  try {
    await fixture.service.scan();
    const observed = fixture.service.listThreads()[0]!;
    expect(observed.history_mode).toBe("paginated");
    await expect(fixture.service.manageThread({
      thread_id: observed.thread_id,
      expected_revision: observed.revision,
      objective: "must remain read-only",
    })).rejects.toThrow("paginated history");
    expect(fixture.service.getThread(observed.thread_id).thread.mode).toBe("observed");
  } finally {
    await fixture.close();
  }
});

test("resume recreates a missing App Server goal before changing local state", async () => {
  const fixture = await serviceFixture();
  try {
    await fixture.service.scan();
    const observed = fixture.service.listThreads()[0]!;
    const managed = await fixture.service.manageThread({
      thread_id: observed.thread_id,
      expected_revision: observed.revision,
      objective: "recover the supervised goal",
      token_budget: 321,
    });
    expect(fixture.goal).toBeNull();

    const resumed = await fixture.service.resumeThread(managed.thread_id, managed.revision);
    expect(fixture.goal).toEqual({
      objective: "recover the supervised goal",
      status: "active",
      tokenBudget: 321,
    });
    expect(resumed).toMatchObject({ phase: "aligning", goal_status: "active" });
  } finally {
    await fixture.close();
  }
});

test("approval bridge stores a concrete request and only responds after the operator answers", async () => {
  const fixture = await serviceFixture();
  try {
    await fixture.service.scan();
    const observed = fixture.service.listThreads()[0]!;
    await fixture.service.manageThread({
      thread_id: observed.thread_id, expected_revision: observed.revision, objective: "approval test",
    });
    fixture.service.handleServerRequest({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { threadId: observed.thread_id, turnId: "turn-1", itemId: "item-1", command: "git push" },
    }, "connection-1");
    expect(fixture.client.responses).toHaveLength(0);
    const approval = fixture.service.listInteractions({ status: "open" })[0]!;
    expect(approval).toMatchObject({ kind: "approval", status: "open" });
    expect(approval.options.map((option) => option.id)).toEqual(["accept", "decline", "cancel"]);

    const resolved = await fixture.service.answerInteraction({
      id: approval.id, expected_revision: approval.revision, selected_option_id: "decline",
    });
    expect(resolved.status).toBe("resolved");
    expect(fixture.client.responses).toEqual([{ id: 9, result: { decision: "decline" } }]);
  } finally {
    await fixture.close();
  }
});

test("budget exhaustion pauses supervision without interrupting the active turn", async () => {
  const fixture = await serviceFixture();
  try {
    await fixture.service.scan();
    const observed = fixture.service.listThreads()[0]!;
    await fixture.service.manageThread({
      thread_id: observed.thread_id, expected_revision: observed.revision,
      objective: "bounded goal", token_budget: 10,
    });
    fixture.service.handleNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: observed.thread_id, turnId: "turn-1",
        tokenUsage: { total: { totalTokens: 10 } },
      },
    }, "connection-1");
    await fixture.service.cycle();
    expect(fixture.service.getThread(observed.thread_id).thread).toMatchObject({ phase: "paused", goal_status: "paused" });
    expect(fixture.client.interrupts).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("concurrent refreshes share one App Server scan", async () => {
  const fixture = await serviceFixture();
  try {
    await Promise.all([fixture.service.scan(), fixture.service.scan()]);
    expect(fixture.client.scans).toBe(1);
  } finally {
    await fixture.close();
  }
});

async function serviceFixture(options: { historyMode?: "legacy" | "paginated" } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-codex-service-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "totemora-codex-service-work-"));
  await new SettlementStore(dataDir).addWorkplace("Fixture", workspace);
  const fake = {
    goal: null as CodexThreadGoal | null,
    started: [] as Array<{ threadId: string; text: string; id: string }>,
    responses: [] as JsonObject[],
    resumes: [] as JsonObject[],
    interrupts: 0,
    scans: 0,
  };
  const client = {
    listAllThreads: async () => {
      fake.scans += 1;
      return [{
        id: "thread-1", cwd: workspace, preview: "fixture", source: { kind: "cli" },
        status: { type: "idle" as const }, historyMode: options.historyMode ?? "legacy",
        createdAt: 1, updatedAt: 2, turns: [],
      }];
    },
    resumeManagedThread: async (_threadId: string, overrides: JsonObject = {}) => {
      fake.resumes.push(overrides);
      return { id: "thread-1", cwd: workspace, status: { type: "idle" } };
    },
    getGoal: async () => fake.goal,
    setGoal: async (_threadId: string, patch: Partial<CodexThreadGoal>) => {
      fake.goal = { objective: patch.objective ?? fake.goal?.objective ?? "", status: patch.status ?? "active", tokenBudget: patch.tokenBudget ?? null };
      return fake.goal;
    },
    startManagedTurn: async (threadId: string, text: string, id: string) => {
      const turnId = `turn-${fake.started.length + 1}`;
      fake.started.push({ threadId, text, id });
      return { turn: { id: turnId, status: "inProgress" } };
    },
    steerTurn: async () => ({ turn: { id: "turn-1" } }),
    respond: (id: string | number, result: unknown) => fake.responses.push({ id, result }),
    respondError: (id: string | number, code: number, message: string) => fake.responses.push({ id, error: { code, message } }),
    interruptTurn: async () => { fake.interrupts += 1; return {}; },
  };
  const service = new CodexSupervisorService(
    dataDir, "/fixture.sock", true, "fixture-runner", () => new Date("2026-08-29T00:00:00Z"),
    "http://127.0.0.1:4310/mcp/codex-agent",
  );
  service.attachConnection(client as unknown as CodexAppServerClient, "connection-1");
  return {
    service,
    client: fake,
    get goal() { return fake.goal; },
    set goal(value: CodexThreadGoal | null) { fake.goal = value; },
    close: async () => {
      await rm(dataDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}
