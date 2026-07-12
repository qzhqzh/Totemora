import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";

import { runCli } from "./commands";
import type {
  AgentProvider,
  ModelRequest,
  ModelResponse,
  ProviderRegistry,
} from "@totemora/core";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lists configured providers", async () => {
  const output = createOutput();

  const exitCode = await runCli(
    ["providers", "list", "--config-dir", "configs/example"],
    output,
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("Providers");
  expect(output.stdoutText()).toContain("openai");
  expect(output.stdoutText()).toContain("qwen");
  expect(output.stdoutText()).toContain("deepseek");
  expect(output.stdoutText()).toContain("xiaomi");
});

test("lists configured agents with roles and tools", async () => {
  const output = createOutput();

  const exitCode = await runCli(
    ["agents", "list", "--config-dir", "configs/example"],
    output,
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("gpt_chief");
  expect(output.stdoutText()).toContain("deepseek_reasoner");
  expect(output.stdoutText()).toContain("qwen_worker");
  expect(output.stdoutText()).toContain("mimo_scout");
});

test("inspects configured tribe", async () => {
  const output = createOutput();

  const exitCode = await runCli(
    ["tribe", "inspect", "--config-dir", "configs/example"],
    output,
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("Tribe: first_tribe");
  expect(output.stdoutText()).toContain("Chief: deepseek_reasoner");
  expect(output.stdoutText()).toContain("Required roles: chief");
  expect(output.stdoutText()).toContain("Manual auto apply: false");
});

test("checks every configured provider with its first member", async () => {
  const output = createOutput();
  const provider = new ReadyProvider();

  const exitCode = await runCli(
    ["providers", "doctor", "--config-dir", "configs/example"],
    output,
    { createProviderRegistry: () => new SharedRegistry(provider) },
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("openai: skipped (no active member)");
  expect(output.stdoutText()).toContain("qwen: ready member=qwen_worker");
  expect(output.stdoutText()).toContain(
    "deepseek: ready member=deepseek_reasoner",
  );
  expect(output.stdoutText()).toContain("xiaomi: ready member=mimo_scout");
  expect(provider.requests).toHaveLength(3);
});

test("runs the onboarding exam through the CLI and persists its trace", async () => {
  const output = createOutput();
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-run-"));
  tempDirs.push(dataDir);
  const provider = new OnboardingProvider();

  const exitCode = await runCli(
    [
      "run",
      "onboarding-exam",
      "--config-dir",
      "configs/example",
      "--data-dir",
      dataDir,
    ],
    output,
    { createProviderRegistry: () => new SharedRegistry(provider) },
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("Totemora 新成员入门考核");
  expect(output.stdoutText()).toContain("3. 第 3 题");
  const runId = output.stdoutText().match(/Run: ([\w-]+)/)?.[1];
  expect(runId).toBeTruthy();
  const persisted = JSON.parse(
    await readFile(join(dataDir, "runs", `${runId}.json`), "utf8"),
  );
  expect(persisted.status).toBe("completed");
  expect(persisted.final_artifact.questions).toHaveLength(3);
});

test("runs a generic read-only workspace goal and prints an evidence report", async () => {
  const output = createOutput();
  const workspace = await mkdtemp(join(tmpdir(), "totemora-demo-"));
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-run-"));
  tempDirs.push(workspace, dataDir);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "README.md"), "# Demo\nA small service.\n");
  await writeFile(
    join(workspace, "src", "index.ts"),
    "export const service = 'demo';\n",
  );

  const exitCode = await runCli(
    [
      "run",
      "分析这个 demo 项目的结构",
      "--workspace",
      workspace,
      "--accept",
      "引用真实文件",
      "--config-dir",
      "configs/example",
      "--data-dir",
      dataDir,
    ],
    output,
    { createProviderRegistry: () => new SharedRegistry(new GenericProvider()) },
  );

  expect(exitCode).toBe(0);
  expect(output.stdoutText()).toContain("Workspace: 2 files");
  expect(output.stdoutText()).toContain("[planning]");
  expect(output.stdoutText()).toContain("[executing]");
  expect(output.stdoutText()).toContain("[reviewing]");
  expect(output.stdoutText()).toContain("[completed]");
  expect(output.stdoutText()).toContain("# Demo 项目结构分析");
  expect(output.stdoutText()).toContain("Evidence: src/index.ts");
  expect(output.stdoutText()).toContain("Usage: 0 tokens across 5 calls");
  expect(output.stdoutText()).toContain("Outcome: accepted");
  const runId = output.stdoutText().match(/Run: ([\w-]+)/)?.[1];
  const persisted = JSON.parse(
    await readFile(join(dataDir, "runs", `${runId}.json`), "utf8"),
  );
  expect(persisted.task.constraints.read_only).toBe(true);
  expect(persisted.final_report.findings).toHaveLength(1);
  expect(persisted.usage.calls).toBe(5);
  expect(persisted.review_outcome).toBe("accepted");
  expect(persisted.independent_review.reviewer_member_id).toBe("qwen_worker");
  expect(persisted.schema_version).toBe(2);
  expect(persisted.task_analysis.features).toContain("workspace_evidence");
  expect(persisted.plan.assignments[0].assignment_reason).toBeTruthy();
});

test("returns non-zero with clear output for invalid config", async () => {
  const configDir = await createInvalidConfigDir();
  const output = createOutput();

  const exitCode = await runCli(
    ["providers", "list", "--config-dir", configDir],
    output,
  );

  expect(exitCode).toBe(1);
  expect(output.stderrText()).toContain("Config validation failed");
  expect(output.stderrText()).toContain("agents.yaml");
  expect(output.stderrText()).toContain("Unknown provider reference");
});

test("prepares a development proposal through the persistent gateway", async () => {
  const output = createOutput();
  const previous = process.env.TOTEMORA_OPERATOR_TOKEN;
  process.env.TOTEMORA_OPERATOR_TOKEN = "test-operator";
  let receivedUrl = "";
  let receivedBody: unknown;
  try {
    const exitCode = await runCli(
      ["development", "prepare", "--workplace", "workplace-1", "--goal", "按规范提交当前改动"],
      output,
      { fetch: async (input, init) => {
        receivedUrl = String(input);
        receivedBody = JSON.parse(String(init?.body));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-operator");
        return Response.json({
          id: "proposal-1", status: "awaiting_approval", summary: "提交当前改动",
          commit_message: "feat(core): add behavior", files: ["src.ts"],
          review: { outcome: "accepted" },
        });
      } },
    );
    expect(exitCode).toBe(0);
    expect(receivedUrl).toBe("http://127.0.0.1:4310/api/development/prepare");
    expect(receivedBody).toEqual({ workplace_id: "workplace-1", goal: "按规范提交当前改动" });
    expect(output.stdoutText()).toContain("Proposal: proposal-1");
  } finally {
    if (previous === undefined) delete process.env.TOTEMORA_OPERATOR_TOKEN;
    else process.env.TOTEMORA_OPERATOR_TOKEN = previous;
  }
});

function createOutput(): {
  stdout: { write: (chunk: string) => void };
  stderr: { write: (chunk: string) => void };
  stdoutText: () => string;
  stderrText: () => string;
} {
  const chunks = {
    stdout: [] as string[],
    stderr: [] as string[],
  };

  return {
    stdout: {
      write(chunk: string) {
        chunks.stdout.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        chunks.stderr.push(chunk);
      },
    },
    stdoutText: () => chunks.stdout.join(""),
    stderrText: () => chunks.stderr.join(""),
  };
}

class ReadyProvider implements AgentProvider {
  readonly requests: ModelRequest[] = [];

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return { content: "READY", usage: { totalTokens: 2 } };
  }
}

class SharedRegistry implements ProviderRegistry {
  constructor(private readonly provider: AgentProvider) {}

  get(): AgentProvider {
    return this.provider;
  }
}

class OnboardingProvider implements AgentProvider {
  private chiefCalls = 0;

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.memberId === "deepseek_reasoner") {
      this.chiefCalls += 1;
      if (this.chiefCalls === 1) {
        return {
          content: JSON.stringify({
            summary: "让两个成员分别设计题目。",
            assignments: [
              assignment("draft_1", "qwen_worker"),
              assignment("draft_2", "mimo_scout"),
            ],
          }),
        };
      }
      return {
        content: JSON.stringify({
          title: "Totemora 新成员入门考核",
          instructions: "回答全部三题。",
          questions: [
            question(1, "qwen_worker"),
            question(2, "mimo_scout"),
            question(3, "mimo_scout"),
          ],
        }),
      };
    }
    return { content: `${request.memberId} 的题目草案` };
  }
}

class GenericProvider implements AgentProvider {
  private chiefCalls = 0;

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.memberId === "qwen_worker" && request.responseFormat === "json") {
      return { content: JSON.stringify({ outcome: "accepted", rationale: "报告有文件证据", issues: [] }) };
    }
    if (request.memberId === "deepseek_reasoner") {
      this.chiefCalls += 1;
      if (this.chiefCalls === 1) {
        return {
          content: JSON.stringify({
            summary: "分别分析入口和文档。",
            assignments: [
              assignment("source", "qwen_worker"),
              assignment("docs", "mimo_scout"),
            ],
          }),
        };
      }
      return {
        content: JSON.stringify({
          title: "Demo 项目结构分析",
          summary: "这是一个小型服务。",
          findings: [
            {
              claim: "项目导出了 demo service",
              evidence: ["src/index.ts: export const service"],
            },
          ],
          recommendations: [
            { priority: "medium", action: "补充测试", reason: "快照中没有测试" },
          ],
          acceptance_review: [
            {
              criterion: "引用真实文件",
              status: "passed",
              evidence: "引用 src/index.ts",
            },
          ],
        }),
      };
    }
    return { content: `${request.memberId} 已分析 Workspace。` };
  }
}

function assignment(id: string, memberId: string) {
  return {
    id,
    member_id: memberId,
    role: "exam_designer",
    instruction: "设计一道入门题",
    acceptance: ["包含题目和答案"],
    skills: ["onboarding-exam-design"],
    assignment_reason: `${memberId} is suitable for this bounded task`,
    selection_factors: ["skill_match", "cost"],
  };
}

function question(id: number, memberId: string) {
  return {
    id,
    prompt: `第 ${id} 题`,
    answer: `答案 ${id}`,
    rationale: `考察基础能力 ${id}`,
    author_member_id: memberId,
  };
}

async function createInvalidConfigDir(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "totemora-invalid-config-"));
  tempDirs.push(configDir);
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(configDir, "providers.yaml"),
    [
      "providers:",
      "  openai:",
      "    type: openai_compatible",
      "    base_url: https://api.openai.com/v1",
      "    api_key_env: OPENAI_API_KEY",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(configDir, "agents.yaml"),
    [
      "agents:",
      "  - id: broken_agent",
      "    provider: missing_provider",
      "    model: gpt-5",
      "    profile:",
      "      reasoning: 0.95",
      "    eligible_roles:",
      "      - chief",
      "    tools:",
      "      - file_read",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(configDir, "roles.yaml"),
    [
      "roles:",
      "  chief:",
      "    required_capabilities:",
      "      reasoning: 0.35",
      "    max_agents: 1",
      "    permissions:",
      "      - decide_plan",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(configDir, "tribe.yaml"),
    [
      "tribe:",
      "  id: default",
      "  name: Default Tribe",
      "  election:",
      "    strategy: weighted_score",
      "    required_roles:",
      "      - chief",
      "  council:",
      "    proposal_count: 3",
      "    chief_must_choose_one: true",
      "  execution:",
      "    max_retry_before_help: 2",
      "    help_targets:",
      "      - chief",
      "  review:",
      "    required: true",
      "    reviewer: chief",
      "  manual:",
      "    allow_agent_proposals: true",
      "    auto_apply: false",
      "",
    ].join("\n"),
    "utf8",
  );

  return configDir;
}
