import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TotemoraGatewayClient } from "./gateway-client";
import { createTotemoraMcpServer } from "./server";

const proposal = {
  id: "proposal-1",
  status: "awaiting_approval",
  mode: "merge",
  issue_mode: "auto",
  workplace_id: "workplace-1",
  workplace_name: "Demo",
  goal: "按规范提交当前改动",
  created_at: "2026-07-14T00:00:00.000Z",
  snapshot_hash: "snapshot-1",
  policy_version: 1,
  specialist_member_id: "deepseek_git_steward",
  assignment_reason: "Git 提交专员最匹配",
  skill: { id: "git-change-management", version: 3 },
  git_context: { branch: "feat/demo", has_develop: false, unpushed_commits: 0, stash_count: 0 },
  files: ["src/demo.ts"],
  summary: "整理现有改动",
  commit_message: "feat: add demo",
  risk: "low",
  validation_commands: ["bun test"],
  self_check: { outcome: "accepted", rationale: "范围一致", issues: [] },
  chief_acceptance: { outcome: "accepted", rationale: "验收通过", issues: [] },
};

test("exposes one persistent Git Flow capability through MCP", async () => {
  const requests: Array<{ path: string; method: string }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init?.method ?? "GET" });
    if (url.pathname === "/api/status") return Response.json({ version: "0.5.0-git-flow-steward", settlement: "ready" });
    if (url.pathname === "/api/tribe") return Response.json({ tribe: { id: "first-fire", name: "初火部落" }, members: [] });
    if (url.pathname === "/api/settlement") return Response.json({ workplaces: [{ id: "workplace-1", name: "Demo", policy: { version: 1 } }] });
    if (url.pathname === "/api/assets") return Response.json({ assets: [{ id: "git-flow-engine", maturity: "verified" }] });
    if (url.pathname === "/api/development/tasks" && init?.method === "POST") {
      return Response.json({ id: "task-1", kind: "git_flow", status: "queued", workplace_id: "workplace-1", goal: proposal.goal, mode: "merge", issue_mode: "auto" });
    }
    if (url.pathname === "/api/development/tasks/task-1") {
      return Response.json({ id: "task-1", kind: "git_flow", status: "completed", proposal_id: proposal.id, result: proposal });
    }
    if (url.pathname === "/api/development/proposals") return Response.json({ proposals: [proposal] });
    if (url.pathname === "/api/development/proposals/proposal-1/advance") {
      return Response.json({ ...proposal, status: "completed", commit_sha: "a".repeat(40) });
    }
    if (url.pathname === "/api/development/proposals/proposal-1") return Response.json(proposal);
    return Response.json({ error: "not found" }, { status: 404 });
  };
  const gateway = new TotemoraGatewayClient({
    gatewayUrl: "http://gateway.local",
    operatorToken: "operator-token",
    fetch: request as typeof fetch,
  });
  const server = createTotemoraMcpServer(gateway);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual([
    "totemora_status",
    "totemora_list_workplaces",
    "totemora_list_assets",
    "totemora_start_git_flow",
    "totemora_get_task",
    "totemora_list_git_flows",
    "totemora_get_git_flow",
    "totemora_advance_git_flow",
  ]);
  expect(tools.tools.find((tool) => tool.name === "totemora_advance_git_flow")?.annotations?.destructiveHint).toBe(true);

  const assets = await client.callTool({ name: "totemora_list_assets", arguments: {} });
  expect(assets.structuredContent).toMatchObject({ assets: [{ id: "git-flow-engine", maturity: "verified" }] });

  const prepared = await client.callTool({
    name: "totemora_start_git_flow",
    arguments: { workplace_id: "workplace-1", goal: "按规范提交当前改动", mode: "merge", issue_mode: "auto" },
  });
  expect(prepared.isError).not.toBe(true);
  expect(prepared.structuredContent).toMatchObject({ id: "task-1", status: "queued" });

  const completedTask = await client.callTool({
    name: "totemora_get_task",
    arguments: { task_id: "task-1" },
  });
  expect(completedTask.structuredContent).toMatchObject({
    status: "completed",
    result: { id: "proposal-1", specialist_member_id: "deepseek_git_steward" },
  });

  const rejected = await client.callTool({
    name: "totemora_advance_git_flow",
    arguments: {
      workflow_id: "proposal-1",
      gate: "local",
      expected_status: "awaiting_approval",
      expected_snapshot_hash: "wrong",
      expected_commit_message: "feat: add demo",
      confirmation: "APPROVE_GIT_FLOW_STAGE",
    },
  });
  expect(rejected.isError).toBe(true);
  expect(requests.some((item) => item.path.endsWith("/approve"))).toBe(false);

  const approved = await client.callTool({
    name: "totemora_advance_git_flow",
    arguments: {
      workflow_id: "proposal-1",
      gate: "local",
      expected_status: "awaiting_approval",
      expected_snapshot_hash: "snapshot-1",
      expected_commit_message: "feat: add demo",
      confirmation: "APPROVE_GIT_FLOW_STAGE",
    },
  });
  expect(approved.structuredContent).toMatchObject({ status: "completed", commit_sha: "a".repeat(40) });

  const resource = await client.readResource({ uri: "totemora://capabilities" });
  const capability = resource.contents[0];
  expect(capability && "text" in capability ? capability.text : "").toContain("persistent Git Flow capability");
  await client.close();
  await server.close();
});
