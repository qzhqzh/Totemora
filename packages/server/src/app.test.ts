import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentProvider, ModelRequest, ModelResponse } from "@totemora/core";
import { createPlaygroundApp } from "./app";

test("exposes tribe and completes a playground run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-web-test-"));
  const provider = new PlaygroundProvider();
  const app = createPlaygroundApp({
    configDir: resolve(import.meta.dir, "../../../configs/example"),
    dataDir,
    createProviderRegistry: () => ({ get: () => provider }),
  });
  const tribe = await app.fetch(new Request("http://local/api/tribe"));
  expect(tribe.status).toBe(200);
  expect((await tribe.json()).members.length).toBeGreaterThan(1);
  expect(await (await app.fetch(new Request("http://local/api/status"))).json()).toMatchObject({
    version: "0.5.0-git-flow-steward", active_members: 4,
    capabilities: { inspect: "enabled", change: "git_flow_existing_changes", specialist_self_review: "enabled" },
  });
  const tribeData = await (await app.fetch(new Request("http://local/api/tribe"))).json();
  expect(tribeData.members.filter((member: any) => !["inactive", "retired"].includes(member.status))).toHaveLength(4);
  expect(tribeData.members.find((member: any) => member.id === "deepseek_reasoner").persona).toContain("深思");
  const embers = await (await app.fetch(new Request("http://local/api/embers"))).json();
  expect(embers.embers).toHaveLength(4);
  expect(embers.embers.find((ember: any) => ember.provider_id === "deepseek")).toMatchObject({
    id: "deepseek/deepseek-v4-pro[1m]", status: "available", member_ids: ["deepseek_reasoner", "deepseek_git_steward"],
  });

  const workplaceResponse = await app.fetch(new Request("http://local/api/workplaces", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Demo", path: resolve(import.meta.dir, "../../../examples/demo-project") }),
  }));
  const workplace = await workplaceResponse.json();
  const analysis = await app.fetch(new Request("http://local/api/intake/analyze", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "修复折扣错误", workplace_id: workplace.id }),
  }));
  expect(await analysis.json()).toMatchObject({ type: "change", execution_enabled: false });

  const started = await app.fetch(new Request("http://local/api/runs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "分析 Demo",
      workplace_id: workplace.id,
      acceptance: ["引用 README.md"],
    }),
  }));
  expect(started.status).toBe(202);
  const jobId = (await started.json()).id as string;
  let job: any;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    job = await (await app.fetch(new Request(`http://local/api/runs/${jobId}`))).json();
    if (["completed", "failed"].includes(job.status)) break;
    await Bun.sleep(5);
  }
  expect(job.status).toBe("completed");
  expect(job.run.schema_version).toBe(2);
  expect(job.run.plan.assignments[0].assignment_reason).toContain("匹配");
  expect(job.run.plan.candidate_ranking).toHaveLength(3);
  expect(job.run.independent_review).toMatchObject({ reviewer_member_id: "qwen_worker", outcome: "accepted" });
  expect(job.run.final_report.findings[0].evidence[0]).toContain("README.md");
  const history = await app.fetch(new Request("http://local/api/runs"));
  expect((await history.json()).runs[0]).toMatchObject({ status: "completed", goal: "分析 Demo" });
  const settlement = await app.fetch(new Request("http://local/api/settlement"));
  const settlementData = await settlement.json();
  expect(settlementData.missions[0].requests[0].run_id).toBe(jobId);
  await rm(dataDir, { recursive: true, force: true });
});

test("retries a retryable failed job in the same mission", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-retry-test-"));
  const provider = new FlakyProvider();
  const app = createPlaygroundApp({
    configDir: resolve(import.meta.dir, "../../../configs/example"), dataDir,
    createProviderRegistry: () => ({ get: () => provider }),
  });
  const started = await app.fetch(new Request("http://local/api/runs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "分析 Demo", workspace: resolve(import.meta.dir, "../../../examples/demo-project"), acceptance: ["引用 README.md"] }),
  }));
  const failed = await waitForJob(app, (await started.json()).id);
  expect(failed).toMatchObject({ status: "failed", failure: { category: "provider", retryable: true } });

  const restoredApp = createPlaygroundApp({
    configDir: resolve(import.meta.dir, "../../../configs/example"), dataDir,
    createProviderRegistry: () => ({ get: () => provider }),
  });
  const retriedResponse = await restoredApp.fetch(new Request(`http://local/api/runs/${failed.id}/retry`, { method: "POST" }));
  expect(retriedResponse.status).toBe(202);
  const retried = await waitForJob(restoredApp, (await retriedResponse.json()).id);
  expect(retried.status).toBe("completed");
  expect(retried.mission_id).toBe(failed.mission_id);
  await rm(dataDir, { recursive: true, force: true });
});

test("protects development policy mutations with the operator token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-operator-test-"));
  const app = createPlaygroundApp({
    configDir: resolve(import.meta.dir, "../../../configs/example"), dataDir,
    operatorToken: "operator-secret",
    createProviderRegistry: () => ({ get: () => new PlaygroundProvider() }),
  });
  const workplace = await (await app.fetch(new Request("http://local/api/workplaces", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Protected", path: "/tmp/protected" }),
  }))).json();
  const body = JSON.stringify({
    instructions: "按规范提交", validation_commands: ["bun test"],
    allowed_commit_types: ["feat"], forbidden_paths: [".env"],
  });
  const denied = await app.fetch(new Request(`http://local/api/workplaces/${workplace.id}/policy`, {
    method: "PUT", headers: { "content-type": "application/json" }, body,
  }));
  expect(denied.status).toBe(400);
  expect((await denied.json()).error).toContain("authorization failed");
  const allowed = await app.fetch(new Request(`http://local/api/workplaces/${workplace.id}/policy`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer operator-secret" }, body,
  }));
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({ version: 1, instructions: "按规范提交" });

  const taskBody = JSON.stringify({ workplace_id: workplace.id, goal: "按规范提交当前改动" });
  const deniedTask = await app.fetch(new Request("http://local/api/development/tasks", {
    method: "POST", headers: { "content-type": "application/json" }, body: taskBody,
  }));
  expect(deniedTask.status).toBe(400);
  const startedTask = await app.fetch(new Request("http://local/api/development/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer operator-secret" },
    body: taskBody,
  }));
  expect(startedTask.status).toBe(202);
  const taskId = (await startedTask.json()).id as string;
  const failedTask = await waitForDevelopmentTask(app, taskId, "operator-secret");
  expect(failedTask).toMatchObject({ kind: "git_flow", status: "failed", retryable: true });

  const restoredApp = createPlaygroundApp({
    configDir: resolve(import.meta.dir, "../../../configs/example"), dataDir,
    operatorToken: "operator-secret",
    createProviderRegistry: () => ({ get: () => new PlaygroundProvider() }),
  });
  const restored = await restoredApp.fetch(new Request(`http://local/api/development/tasks/${taskId}`, {
    headers: { authorization: "Bearer operator-secret" },
  }));
  expect(await restored.json()).toMatchObject({ id: taskId, status: "failed" });
  await rm(dataDir, { recursive: true, force: true });
});

async function waitForJob(app: ReturnType<typeof createPlaygroundApp>, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await (await app.fetch(new Request(`http://local/api/runs/${id}`))).json();
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await Bun.sleep(5);
  }
  throw new Error("Job did not finish");
}

async function waitForDevelopmentTask(app: ReturnType<typeof createPlaygroundApp>, id: string, token: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await (await app.fetch(new Request(`http://local/api/development/tasks/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    }))).json();
    if (["completed", "failed"].includes(task.status)) return task;
    await Bun.sleep(5);
  }
  throw new Error("Development task did not finish");
}

class PlaygroundProvider implements AgentProvider {
  private chiefCalls = 0;
  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.memberId !== "deepseek_reasoner") {
      if (request.responseFormat === "json") return { content: JSON.stringify({ outcome: "accepted", rationale: "证据满足验收标准", issues: [] }) };
      return { content: "README.md 说明了项目规则。" };
    }
    this.chiefCalls += 1;
    if (this.chiefCalls === 1) return { content: JSON.stringify({
      summary: "交给一个低成本成员读取文档。",
      assignments: [{
        id: "read_docs", member_id: "mimo_scout", role: "scout",
        instruction: "检查 README", acceptance: ["引用 README.md"],
        skills: ["fact-checking"], assignment_reason: "阅读能力与任务匹配",
        selection_factors: ["reading", "cost"],
      }],
    }) };
    return { content: JSON.stringify({
      title: "Demo 分析", summary: "已完成文档检查。",
      findings: [{ claim: "存在项目说明", evidence: ["README.md: 项目规则"] }],
      recommendations: [{ priority: "low", action: "保持说明", reason: "规则清晰" }],
      acceptance_review: [{ criterion: "引用 README.md", status: "passed", evidence: "README.md" }],
    }) };
  }
}

class FlakyProvider extends PlaygroundProvider {
  private failed = false;
  override async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("Provider deepseek request failed (503): temporary");
    }
    return super.generate(request);
  }
}
