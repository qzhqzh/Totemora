import { expect, test } from "bun:test";

import type { LocalConfigSet } from "../config";
import type {
  AgentProvider,
  ModelRequest,
  ModelResponse,
  ProviderRegistry,
} from "../provider";
import { TribeRuntime } from "./tribe-runtime";
import type { RunStore, TribeRun } from "./types";

test("chief delegates an onboarding exam and accepts exactly three questions", async () => {
  const provider = new ScriptedProvider([
    {
      content: JSON.stringify({
        summary: "Three specialists each draft one entry-level question.",
        assignments: [
          assignment("draft_deepseek", "deepseek_reasoner", "逻辑推理"),
          assignment("draft_qwen", "qwen_worker", "指令遵循"),
          assignment("draft_mimo", "mimo_scout", "事实核查"),
        ],
      }),
    },
    { content: "问题草案 A" },
    { content: "问题草案 B" },
    { content: "问题草案 C" },
    {
      content: JSON.stringify({
        title: "Totemora 新成员入门考核",
        instructions: "回答全部三题。",
        questions: [
          question(1, "deepseek_reasoner"),
          question(2, "qwen_worker"),
          question(3, "mimo_scout"),
        ],
      }),
    },
  ]);
  const store = new MemoryRunStore();
  const runtime = new TribeRuntime(
    createConfig(),
    new SingleProviderRegistry(provider),
    store,
    { now: () => new Date("2026-07-10T00:00:00.000Z"), id: () => "run_exam" },
  );

  const run = await runtime.runOnboardingExam();

  expect(run.status).toBe("completed");
  expect(run.schema_version).toBe(2);
  expect(run.task_analysis.type).toBe("onboarding");
  expect(run.member_versions.find((item) => item.member_id === "qwen_worker"))
    .toMatchObject({ member_version: 1, model: "test-model" });
  expect(run.final_artifact?.questions).toHaveLength(3);
  expect(run.plan?.assignments.map((item) => item.member_id)).toEqual([
    "deepseek_reasoner",
    "qwen_worker",
    "mimo_scout",
  ]);
  expect(provider.requests[0]?.memberId).toBe("gpt_chief");
  expect(provider.requests.at(-1)?.memberId).toBe("gpt_chief");
  expect(store.runs.at(-1)?.status).toBe("completed");
});

test("rejects a chief plan that assigns work to an unknown member", async () => {
  const provider = new ScriptedProvider([
    {
      content: JSON.stringify({
        summary: "invalid",
        assignments: [assignment("draft", "missing_member", "出题")],
      }),
    },
    {
      content: JSON.stringify({
        summary: "still invalid",
        assignments: [assignment("draft", "missing_member", "出题")],
      }),
    },
  ]);
  const store = new MemoryRunStore();
  const runtime = new TribeRuntime(
    createConfig(),
    new SingleProviderRegistry(provider),
    store,
    { now: () => new Date("2026-07-10T00:00:00.000Z"), id: () => "run_invalid" },
  );

  await expect(runtime.runOnboardingExam()).rejects.toThrow(
    "Chief assigned unknown member: missing_member",
  );
  expect(store.runs.at(-1)?.status).toBe("failed");
  expect(store.runs.at(-1)?.failure).toMatchObject({ category: "staffing", owner: "chief" });
});

test("enforces the maximum selected member budget", async () => {
  const twoMemberPlan = {
    content: JSON.stringify({
      summary: "too many members",
      assignments: [
        assignment("one", "qwen_worker", "分析入口"),
        assignment("two", "mimo_scout", "分析风险"),
      ],
    }),
  };
  const store = new MemoryRunStore();
  const runtime = new TribeRuntime(
    createConfig(), new SingleProviderRegistry(new ScriptedProvider([twoMemberPlan, twoMemberPlan])), store,
    { now: () => new Date("2026-07-10T00:00:00.000Z"), id: () => "run_budget" },
  );
  await expect(runtime.runTask({
    id: "budget_task", goal: "分析 Demo", acceptance: ["引用文件"],
    workspace: { root: "/tmp", files: [{ path: "README.md", content: "demo", truncated: false }], omitted_files: 0, total_bytes: 4 },
    constraints: { read_only: true }, budget: { max_members: 1 },
  })).rejects.toThrow("Staffing plan exceeds max_members budget: 2 > 1");
  expect(store.runs.at(-1)?.failure).toMatchObject({ category: "staffing" });
});

test("stops before a model call when the total token budget is exhausted", async () => {
  const store = new MemoryRunStore();
  const runtime = new TribeRuntime(
    createConfig(), new SingleProviderRegistry(new ScriptedProvider([])), store,
    { now: () => new Date("2026-07-10T00:00:00.000Z"), id: () => "run_token_budget" },
  );
  await expect(runtime.runTask({
    id: "token_budget", goal: "分析 Demo", acceptance: ["引用文件"],
    workspace: { root: "/tmp", files: [{ path: "README.md", content: "demo", truncated: false }], omitted_files: 0, total_bytes: 4 },
    constraints: { read_only: true }, budget: { max_total_tokens: 100 },
  })).rejects.toThrow("Run token budget exhausted before calling");
  expect(store.runs.at(-1)?.failure).toMatchObject({ category: "budget" });
});

test("runs a generic workspace task and requires file-backed evidence", async () => {
  const provider = new ScriptedProvider([
    {
      content: JSON.stringify({
        summary: "Split architecture and risk analysis.",
        assignments: [
          assignment("architecture", "qwen_worker", "分析架构"),
          assignment("risk", "mimo_scout", "识别风险"),
        ],
      }),
    },
    { content: "README.md 描述项目目标。" },
    { content: "src/index.ts 包含入口实现。" },
    { content: "这不是合法的 JSON 报告" },
    {
      content: JSON.stringify({
        title: "Demo 项目分析",
        summary: "项目包含一个 TypeScript 入口。",
        findings: [
          {
            claim: "项目入口位于 src/index.ts",
            evidence: ["src/index.ts: 导出入口函数"],
          },
        ],
        recommendations: [
          { priority: "medium", action: "补充测试", reason: "当前快照未见测试" },
        ],
        acceptance_review: [
          {
            criterion: "引用真实文件",
            status: "passed",
            evidence: "引用 src/index.ts",
          },
        ],
      }),
    },
  ]);
  const store = new MemoryRunStore();
  const runtime = new TribeRuntime(
    createConfig(),
    new SingleProviderRegistry(provider),
    store,
    { now: () => new Date("2026-07-10T00:00:00.000Z"), id: () => "run_generic" },
  );

  const run = await runtime.runTask({
    id: "demo_analysis",
    goal: "分析 Demo 项目",
    acceptance: ["引用真实文件"],
    workspace: {
      root: "/workspace/demo",
      files: [
        { path: "README.md", content: "# Demo", truncated: false },
        { path: "src/index.ts", content: "export function main() {}", truncated: false },
      ],
      omitted_files: 0,
      total_bytes: 37,
    },
    constraints: { read_only: true },
  });

  expect(run.status).toBe("completed");
  expect(run.task_analysis.features).toContain("workspace_evidence");
  expect(run.plan?.assignments[0]?.assignment_reason).toBeTruthy();
  expect(run.plan?.assignments[0]?.selection_score).toBeGreaterThanOrEqual(0);
  expect(run.plan?.assignments[0]?.cost_efficiency).toBeDefined();
  expect(run.final_report?.findings[0]?.evidence[0]).toContain("src/index.ts");
  expect(run.events.map((event) => event.type)).toContain("final_review_completed");
  expect(
    run.events.some(
      (event) =>
        event.type === "model_response_received" &&
        (event.payload as { phase?: string }).phase === "final_review_repair",
    ),
  ).toBe(true);
});

test("cancels an in-flight provider call and persists cancelled status", async () => {
  const controller = new AbortController();
  const provider: AgentProvider = {
    async generate(request) {
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  };
  const store = new MemoryRunStore();
  const runtime = new TribeRuntime(
    createConfig(), new SingleProviderRegistry(provider), store,
    { now: () => new Date("2026-07-10T00:00:00.000Z"), id: () => "run_cancel" },
    {}, { signal: controller.signal },
  );
  const promise = runtime.runTask({
    id: "cancel_task", goal: "分析 Demo", acceptance: ["引用文件"],
    workspace: { root: "/tmp", files: [{ path: "README.md", content: "demo", truncated: false }], omitted_files: 0, total_bytes: 4 },
    constraints: { read_only: true },
  });
  await Bun.sleep(1);
  controller.abort();
  await expect(promise).rejects.toThrow("Run cancelled by user");
  expect(store.runs.at(-1)?.status).toBe("cancelled");
  expect(store.runs.at(-1)?.events.at(-1)?.type).toBe("run_cancelled");
});

function assignment(id: string, memberId: string, instruction: string) {
  return {
    id,
    member_id: memberId,
    role: "exam_designer",
    instruction,
    acceptance: ["产出一道题"],
    skills: ["onboarding-exam-design"],
    assignment_reason: `${memberId} matches this bounded work package`,
    selection_factors: ["skill_match", "cost"],
  };
}

function question(id: number, memberId: string) {
  return {
    id,
    prompt: `第 ${id} 题`,
    answer: `答案 ${id}`,
    rationale: `考察能力 ${id}`,
    author_member_id: memberId,
  };
}

class ScriptedProvider implements AgentProvider {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No scripted response available");
    }
    return response;
  }
}

class SingleProviderRegistry implements ProviderRegistry {
  constructor(private readonly provider: AgentProvider) {}

  get(): AgentProvider {
    return this.provider;
  }
}

class MemoryRunStore implements RunStore {
  readonly runs: TribeRun[] = [];

  async save(run: TribeRun): Promise<void> {
    this.runs.push(structuredClone(run));
  }
}

function createConfig(): LocalConfigSet {
  return {
    providers: {
      providers: {
        shared: {
          type: "openai_compatible",
          base_url: "https://example.test/v1",
          api_key_env: "TEST_API_KEY",
        },
      },
    },
    agents: {
      agents: [
        member("gpt_chief", ["chief", "reviewer"]),
        member("deepseek_reasoner", ["warrior"]),
        member("qwen_worker", ["worker"]),
        member("mimo_scout", ["scout"]),
      ],
    },
    roles: {
      roles: {
        chief: role(),
        reviewer: role(),
        warrior: role(),
        worker: role(),
        scout: role(),
      },
    },
    tribe: {
      tribe: {
        id: "first_tribe",
        name: "First Tribe",
        chief: "gpt_chief",
        election: { strategy: "weighted_score", required_roles: ["chief"] },
        council: { proposal_count: 1, chief_must_choose_one: true },
        execution: { max_retry_before_help: 1, help_targets: ["chief"] },
        review: { required: true, reviewer: "chief" },
        manual: { allow_agent_proposals: true, auto_apply: false },
      },
    },
  };
}

function member(id: string, eligibleRoles: string[]) {
  return {
    id,
    name: id,
    provider: "shared",
    model: "test-model",
    persona: `Persona for ${id}`,
    status: "active" as const,
    version: 1,
    profile: { reasoning: 0.8 },
    eligible_roles: eligibleRoles,
    skills: ["onboarding-exam-design"],
    tools: [],
  };
}

function role() {
  return {
    required_capabilities: { reasoning: 0.5 },
    max_agents: 1,
    permissions: [],
  };
}
