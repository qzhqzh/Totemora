import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexInteraction } from "../domains/codex/codex-supervisor-types";
import { CodexTelegramController, type CodexTelegramOperations } from "./codex-telegram-controller";

test("Codex Telegram exposes bounded decisions while keeping system approvals Web-only", async () => {
  const dataDir = await telegramDataDir();
  const requests: Array<{ method: string; body: Record<string, any> }> = [];
  const decision = interaction("11111111-1111-4111-8111-111111111111", "decision");
  const approval = interaction("22222222-2222-4222-8222-222222222222", "approval");
  const interactions = [decision, approval];
  const answers: unknown[] = [];
  const operations: CodexTelegramOperations = {
    getStatus: () => ({
      enabled: true, connected: true, socket_path: "/tmp/codex.sock", observed_threads: 4,
      running_threads: 3, managed_threads: 2, active_managed_threads: 1, open_interactions: interactions.filter((item) => item.status === "open").length,
      phase_counts: { executing: 1 }, directive_counts: {}, open_interaction_counts: { decision: 1, approval: 1 },
    }),
    listThreads: () => [{ thread_id: "thread-1", cwd: "/repo", preview: "Task", source: {}, app_status: "idle", app_updated_at: 1,
      mode: "managed", phase: "executing", token_used: 10, infra_retries: 0, strategy_attempts: 0,
      last_observed_at: new Date().toISOString(), revision: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    listInteractions: (input = {}) => interactions.filter((item) => !input.status || item.status === input.status),
    answerInteraction: async (input) => {
      answers.push(input);
      decision.status = "resolved";
      decision.selected_option_id = input.selected_option_id;
      decision.revision += 2;
      return decision;
    },
  };
  const controller = new CodexTelegramController({
    dataDir, operations, publicBaseUrl: "https://tribe.example.com/base",
    now: () => new Date("2026-08-29T00:30:10.000Z"),
    fetchImpl: telegramFetch(requests),
  });

  expect(controller.accepts(messageUpdate(1, "/decisions@totemora_bot"))).toBe(true);
  expect(await controller.handleUpdate(messageUpdate(1, "/decisions@totemora_bot")))
    .toEqual({ accepted: true, replayed: false });
  expect((await controller.handleUpdate(messageUpdate(1, "/decisions@totemora_bot"))).replayed).toBe(true);
  const decisionMessage = requests.find((item) => item.method === "sendMessage")!;
  expect(decisionMessage.body.reply_markup.inline_keyboard).toEqual([
    [{ text: "Option A", callback_data: `codex:${decision.id}:0` }],
    [{ text: "Option B", callback_data: `codex:${decision.id}:1` }],
  ]);

  const callback = {
    update_id: 2,
    callback_query: {
      id: "callback-1", data: `codex:${decision.id}:1`,
      from: { id: 9, is_bot: false, first_name: "Owner" },
      message: { message_id: 8, chat: { id: -100123, type: "supergroup" } },
    },
  };
  expect(await controller.handleUpdate(callback)).toMatchObject({ accepted: true, replayed: false });
  expect(answers).toEqual([expect.objectContaining({
    id: decision.id, selected_option_id: "option-b", actor_id: "telegram-operator", channel: "telegram",
  })]);

  const scheduled = await controller.runScheduled();
  expect(scheduled).toEqual({ notified: 1, daily_summaries: 1 });
  const texts = requests.filter((item) => item.method === "sendMessage").map((item) => item.body.text);
  expect(texts.some((text) => text.includes("审批仅限 Web") && text.includes("https://tribe.example.com/codex"))).toBe(true);
  expect(texts.some((text) => text.includes("Codex 每日监督摘要")
    && text.includes("Codex 正在运行 3")
    && text.includes("Totemora 托管中 2 · 正在续跑 1"))).toBe(true);
  expect(requests.filter((item) => item.method === "answerCallbackQuery")).toHaveLength(1);
  await rm(dataDir, { recursive: true, force: true });
});

function interaction(id: string, kind: "decision" | "approval"): CodexInteraction {
  const now = "2026-08-29T00:00:00.000Z";
  return {
    id, thread_id: "thread-1", kind, status: "open", title: kind === "approval" ? "Run command" : "Choose path",
    body: kind === "approval" ? "touch protected-file" : "Which option should Codex use?",
    options: kind === "approval"
      ? [{ id: "accept", label: "Accept", description: "Allow once" }, { id: "decline", label: "Decline", description: "Deny" }]
      : [{ id: "option-a", label: "Option A", description: "First path" }, { id: "option-b", label: "Option B", description: "Second path" }],
    source: kind === "approval" ? "app_server" : "agent", revision: 1, created_at: now, updated_at: now,
  };
}

function messageUpdate(updateId: number, text: string) {
  return { update_id: updateId, message: { message_id: updateId, text, chat: { id: -100123, type: "supergroup" } } };
}

function telegramFetch(requests: Array<{ method: string; body: Record<string, any> }>): typeof fetch {
  return (async (input, init) => {
    const method = String(input).split("/").at(-1)!;
    requests.push({ method, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: requests.length } : true });
  }) as typeof fetch;
}

async function telegramDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-codex-telegram-"));
  const secrets = join(dataDir, "secrets");
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, "telegram-bot-token"), "123456:test_token\n");
  await writeFile(join(secrets, "telegram-chat-ids"), "-100123\n");
  return dataDir;
}
