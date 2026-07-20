import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalConfig, type AgentProvider, type ModelRequest } from "@totemora/core";
import { MemberConversationService } from "./member-conversation-service";
import { MemberStateStore } from "./member-state-store";

test("a member remembers conversation and can ask its mentor for guidance", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-member-chat-"));
  const config = await loadLocalConfig({ configDir: resolve(import.meta.dir, "../../../configs/example") });
  const requests: ModelRequest[] = [];
  const provider: AgentProvider = { async generate(request) {
    requests.push(request);
    return { content: request.memberId === "deepseek_reasoner" ? "先核对两个来源，再标记不确定性。" : "我会先核对来源，并明确标记尚未确认的部分。" };
  } };
  const state = new MemberStateStore(dataDir, config);
  const service = new MemberConversationService(config, { get: () => provider }, state, dataDir);
  const result = await service.chat("qwen_intelligence", "这条消息可靠吗？", true);
  expect(result.guidance).toMatchObject({ author_id: "deepseek_reasoner", role: "mentor_guidance" });
  expect(result.reply.content).toContain("核对来源");
  expect(result.dossier).toMatchObject({ identity: { rank: "apprentice", mentor: { id: "deepseek_reasoner" } }, growth: { help_requests: 1, guidance_received: 1 } });
  expect(requests.map((request) => request.memberId)).toEqual(["deepseek_reasoner", "qwen_intelligence"]);
  await rm(dataDir, { recursive: true, force: true });
});
