import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionJournal } from "../action-journal";
import { ProjectRadarActionConflictError, ProjectRadarActionNotFoundError } from "../domains/intelligence/project-radar-action";
import { TelegramDeliveryError, type TelegramUpdate } from "../telegram-bot-service";
import { ProjectRadarTelegramController, type ProjectRadarTelegramAction, type ProjectRadarTelegramOptions } from "./project-radar-telegram";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
function action(index = 1): ProjectRadarTelegramAction {
  return { id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`, status: "proposed", project_name: "EchoMe",
    title: `检索方法 ${index}`, next_step: "建议核实原文，并对照当前检索方法做小范围验证。",
    evidence: [{ title: "原始发布说明", url: `https://example.com/release/${index}` }] };
}
function message(update_id = 1, text = "/radar", chatId = -100123): TelegramUpdate {
  return { update_id, message: { message_id: update_id, text, chat: { id: chatId, type: "supergroup" } } };
}
function callback(update_id = 2, data = `ra:${action().id}:a`, callbackId = "callback-1"): TelegramUpdate {
  return { update_id, callback_query: { id: callbackId, data, from: { id: 9, is_bot: false, first_name: "Owner" },
    message: { message_id: 10, chat: { id: -100123, type: "supergroup" } } } };
}
async function fixture(items = [action()]) {
  const dataDir = await mkdtemp(join(tmpdir(), "radar-telegram-")); directories.push(dataDir);
  const sent: Array<{ text: string; choices?: Array<{ label: string; callback_data: string }> }> = [];
  const acknowledgements: Array<{ id: string; text: string }> = [];
  const decisions: Array<{ id: string; input: { decision: "accept" | "dismiss"; idempotency_key: string; source: "telegram" } }> = [];
  const receipts = new Map<string, { id: string; decision: string; action: ProjectRadarTelegramAction }>();
  let allowed = true; let lists = 0; let writes = 0;
  const options: ProjectRadarTelegramOptions = {
    dataDir,
    actions: {
      list(limit) { lists += 1; expect(limit).toBe(3); return items; },
      decide(id, input) {
        decisions.push({ id, input });
        const prior = receipts.get(input.idempotency_key);
        if (prior) {
          if (prior.id !== id || prior.decision !== input.decision) throw new ProjectRadarActionConflictError("idempotency conflict");
          return prior.action;
        }
        const found = items.find((item) => item.id === id);
        if (!found) throw new ProjectRadarActionNotFoundError("action not found");
        const status = input.decision === "accept" ? "accepted" : "dismissed";
        if (found.status !== "proposed" && found.status !== status) throw new ProjectRadarActionConflictError("already decided");
        if (found.status === "proposed") { found.status = status; writes += 1; }
        receipts.set(input.idempotency_key, { id, decision: input.decision, action: found });
        return found;
      },
    },
    telegram: {
      async isAllowedChat() { return allowed; },
      async sendChoices(_chat, text, choices) { sent.push({ text, choices }); return { message_id: sent.length, chat_id: "-100123" }; },
      async sendText(_chat, text) { sent.push({ text }); return { message_id: sent.length, chat_id: "-100123" }; },
      async answerCallback(id, text) { acknowledgements.push({ id, text }); },
    },
  };
  return { dataDir, options, items, sent, acknowledgements, decisions, controller: new ProjectRadarTelegramController(options),
    setAllowed(value: boolean) { allowed = value; }, lists: () => lists, writes: () => writes };
}

test("radar handles only explicit commands and denies access before reading actions", async () => {
  const f = await fixture();
  for (const text of ["hello", "看看 /radar", "/radar execute this", "/radars", "/news"]) {
    expect(f.controller.accepts(message(1, text))).toBe(false);
    expect(await f.controller.handleUpdate(message(1, text))).toMatchObject({ ignored: "unmatched_update" });
  }
  f.setAllowed(false);
  expect(await f.controller.handleUpdate(message())).toMatchObject({ ignored: "chat_not_allowlisted" });
  expect(await f.controller.handleUpdate(callback())).toMatchObject({ ignored: "chat_not_allowlisted" });
  f.setAllowed(true);
  const noChat = callback(); delete noChat.callback_query!.message;
  expect(await f.controller.handleUpdate(noChat)).toMatchObject({ ignored: "chat_not_allowlisted" });
  expect(f.lists()).toBe(0); expect(f.decisions).toHaveLength(0); expect(f.sent).toHaveLength(0); expect(f.acknowledgements).toHaveLength(0);
});

test("radar replies with at most three bounded evidence-based choices and persistently deduplicates updates", async () => {
  const f = await fixture(Array.from({ length: 5 }, (_, index) => action(index + 1)));
  expect(f.controller.accepts(message(1, "/radar@totemora_bot"))).toBe(true);
  expect(await f.controller.handleUpdate(message(1, "/radar@totemora_bot"))).toEqual({ accepted: true, replayed: false });
  expect(f.sent).toHaveLength(3);
  for (const [index, sent] of f.sent.entries()) {
    expect(sent.text).toContain("EchoMe"); expect(sent.text).toContain(f.items[index]!.next_step);
    expect(sent.text).toContain(f.items[index]!.evidence[0]!.url); expect(sent.text.length).toBeLessThanOrEqual(4000);
    expect(sent.choices).toEqual([{ label: "采纳", callback_data: `ra:${f.items[index]!.id}:a` }, { label: "忽略", callback_data: `ra:${f.items[index]!.id}:d` }]);
    expect(sent.choices!.every((choice) => Buffer.byteLength(choice.callback_data) <= 64)).toBe(true);
  }
  const restarted = new ProjectRadarTelegramController(f.options);
  expect(await restarted.handleUpdate(message(1, "/radar@totemora_bot"))).toEqual({ accepted: true, replayed: true });
  expect(f.lists()).toBe(1); expect(f.sent).toHaveLength(3);
});

test("radar empty replies and unsupported action IDs never produce invalid buttons", async () => {
  const empty = await fixture([]); await empty.controller.handleUpdate(message());
  expect(empty.sent).toHaveLength(1); expect(empty.sent[0]!.text).toContain("没有");
  const f = await fixture([{ ...action(), id: "x".repeat(100), next_step: "x".repeat(6000),
    evidence: [{ title: "unsafe", url: "javascript:alert(1)" }] }]);
  await f.controller.handleUpdate(message());
  expect(f.sent[0]!.choices).toBeUndefined(); expect(f.sent[0]!.text).toContain("Web");
  expect(f.sent[0]!.text).not.toContain("javascript:"); expect(f.sent[0]!.text.length).toBeLessThanOrEqual(4000);
});

test("radar callbacks use durable decision keys and deduplicate both update and callback IDs", async () => {
  const f = await fixture(); const update = callback();
  expect(await f.controller.handleUpdate(update)).toEqual({ accepted: true, replayed: false });
  expect(await new ProjectRadarTelegramController(f.options).handleUpdate(update)).toEqual({ accepted: true, replayed: true });
  await f.controller.handleUpdate({ ...update, update_id: 3 });
  expect(f.decisions).toHaveLength(1); expect(f.writes()).toBe(1); expect(f.acknowledgements).toHaveLength(1);
  expect(f.decisions[0]).toMatchObject({ id: action().id, input: { decision: "accept", source: "telegram" } });
  expect(f.decisions[0]!.input.idempotency_key.length).toBeLessThanOrEqual(128);
  expect(f.acknowledgements[0]!.text).toContain("已采纳");
});

test("invalid, missing, conflicting and expired callbacks are handled once without overwriting decisions", async () => {
  const f = await fixture();
  for (const [index, data] of ["ra:invalid:a", `ra:${action().id}:x`, `ra:${"a".repeat(90)}:a`].entries()) {
    const update = callback(index + 1, data, `invalid-${index}`);
    expect(await f.controller.handleUpdate(update)).toMatchObject({ ignored: "invalid_callback" });
    await f.controller.handleUpdate(update);
  }
  expect(f.decisions).toHaveLength(0); expect(f.acknowledgements).toHaveLength(3);
  const missing = callback(4, `ra:${action(99).id}:a`, "missing");
  expect(await f.controller.handleUpdate(missing)).toMatchObject({ ignored: "action_unavailable" });
  await f.controller.handleUpdate(missing);
  await f.controller.handleUpdate(callback(5, `ra:${action().id}:a`, "accept"));
  expect(await f.controller.handleUpdate(callback(6, `ra:${action().id}:d`, "dismiss"))).toMatchObject({ ignored: "decision_conflict" });
  expect(f.items[0]!.status).toBe("accepted"); expect(f.writes()).toBe(1);
  let attempts = 0;
  f.options.telegram!.answerCallback = async () => { attempts += 1; throw new TelegramDeliveryError("query is too old", false, 400); };
  const expired = callback(7, `ra:${action(99).id}:a`, "expired");
  await f.controller.handleUpdate(expired); await f.controller.handleUpdate(expired);
  expect(attempts).toBe(1);
});

test("reused update and callback IDs with different requests cannot change decisions", async () => {
  const f = await fixture(); await f.controller.handleUpdate(message(1));
  expect(await f.controller.handleUpdate(callback(1))).toMatchObject({ ignored: "idempotency_conflict" });
  expect(f.decisions).toHaveLength(0);
  await f.controller.handleUpdate(callback(2));
  expect(await f.controller.handleUpdate(callback(3, `ra:${action().id}:d`))).toMatchObject({ ignored: "idempotency_conflict" });
  expect(f.writes()).toBe(1); expect(f.items[0]!.status).toBe("accepted");
});

test("a partly sent radar batch is uncertain and cannot replay even after restart", async () => {
  const f = await fixture([action(), action(2), action(3)]); let sends = 0;
  f.options.telegram!.sendChoices = async () => {
    sends += 1;
    if (sends === 2) throw new TelegramDeliveryError("rate limited", true, 429);
    return { message_id: sends, chat_id: "-100123" };
  };
  expect(await f.controller.handleUpdate(message())).toMatchObject({ uncertain: true });
  expect(await new ProjectRadarTelegramController(f.options).handleUpdate(message())).toMatchObject({ uncertain: true });
  expect(sends).toBe(2);
  expect((await new ActionJournal(f.dataDir).list()).find((entry) => entry.action === "project_radar_update"))
    .toMatchObject({ status: "uncertain", attempts: 1 });
});

test("unknown sends and callback acknowledgements are never automatically repeated", async () => {
  const f = await fixture(); let sends = 0; let acknowledgements = 0;
  f.options.telegram!.sendChoices = async () => { sends += 1; throw new Error("transport response was lost"); };
  expect(await f.controller.handleUpdate(message())).toMatchObject({ uncertain: true });
  await f.controller.handleUpdate(message()); expect(sends).toBe(1);
  f.options.telegram!.answerCallback = async () => { acknowledgements += 1; throw new TelegramDeliveryError("response lost", true, undefined, undefined, true); };
  expect(await f.controller.handleUpdate(callback())).toMatchObject({ uncertain: true });
  await f.controller.handleUpdate(callback());
  await f.controller.handleUpdate({ ...callback(), update_id: 3 });
  expect(acknowledgements).toBe(1); expect(f.writes()).toBe(1); expect(f.decisions).toHaveLength(1);
});

test("a rejected callback acknowledgement retries with the same durable decision key", async () => {
  const f = await fixture(); let acknowledgements = 0;
  f.options.telegram!.answerCallback = async () => {
    acknowledgements += 1;
    if (acknowledgements === 1) throw new TelegramDeliveryError("rate limited", true, 429);
  };
  await expect(f.controller.handleUpdate(callback())).rejects.toThrow("Telegram request was rejected");
  expect(await new ProjectRadarTelegramController(f.options).handleUpdate(callback())).toMatchObject({ replayed: false });
  expect(f.decisions).toHaveLength(2); expect(f.writes()).toBe(1); expect(acknowledgements).toBe(2);
  expect(f.decisions[0]!.input.idempotency_key).toBe(f.decisions[1]!.input.idempotency_key);
});

test("a confirmed rejection before any send can retry safely and concurrent copies never send twice", async () => {
  const f = await fixture(); let sends = 0;
  f.options.telegram!.sendChoices = async () => {
    sends += 1;
    if (sends === 1) throw new TelegramDeliveryError("rate limited", true, 429);
    return { message_id: sends, chat_id: "-100123" };
  };
  await expect(f.controller.handleUpdate(message())).rejects.toThrow("Telegram request was rejected");
  expect(await f.controller.handleUpdate(message())).toMatchObject({ replayed: false });
  expect(sends).toBe(2);
  const other = await fixture(); let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  other.options.telegram!.sendChoices = async () => { calls += 1; started(); await blocked; return { message_id: 1, chat_id: "-100123" }; };
  const first = other.controller.handleUpdate(message()); await entered;
  expect(await other.controller.handleUpdate(message())).toMatchObject({ ignored: "in_progress" });
  release(); await first; expect(calls).toBe(1);
});
