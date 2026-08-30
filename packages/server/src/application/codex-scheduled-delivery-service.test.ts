import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../state-database";
import {
  CodexScheduledDailyLimitError,
  CodexScheduledDeliveryConflictError,
  CodexScheduledDeliveryConfigurationError,
  CodexScheduledDeliveryService,
  CodexScheduledDeliveryUncertainError,
  CodexScheduledSubscriptionLimitError,
  formatTelegramDigest,
} from "./codex-scheduled-delivery-service";

test("scheduled delivery binds one subscription capability to one allowlisted Telegram group", async () => {
  const fixture = await serviceFixture();
  try {
    const created = await fixture.service.createSubscription({ name: "每日重点新闻", target_chat_id: "-100123" });
    expect(created.subscription).toMatchObject({
      name: "每日重点新闻", target_chat_id: "-100123", status: "active", last_delivery_status: "never",
    });
    expect(created.credential).toMatchObject({
      mcp_endpoint: "https://totemora.example/mcp/codex-scheduled",
      tool_name: "publish_scheduled_digest",
    });
    expect(created.credential.prompt).toContain("普通对话和中间进度禁止调用");
    const stored = StateDatabase.open(fixture.dataDir).db.query(`
      SELECT token_hash FROM codex_scheduled_subscriptions WHERE id=?
    `).get(created.subscription.id) as { token_hash: string };
    expect(stored.token_hash).toHaveLength(64);
    expect(stored.token_hash).not.toContain(created.credential.bearer_token);
    expect(fixture.service.authorize(created.credential.bearer_token)).toBe(true);

    const digest = {
      run_key: "2026-08-30",
      title: "今天最值得关注的 3 条新闻",
      body: "一、重点变化。\n二、后续影响。",
      source_urls: ["https://example.com/news"],
      occurred_at: "2026-08-30T08:00:00+08:00",
    };
    expect(await fixture.service.publish(created.credential.bearer_token, digest)).toMatchObject({
      delivered: true, replayed: false, run_key: "2026-08-30",
    });
    const firstDelivery = (await fixture.service.overview()).subscriptions[0]!;
    expect(await fixture.service.publish(created.credential.bearer_token, digest)).toMatchObject({
      delivered: true, replayed: true,
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toMatchObject({ chat_id: "-100123" });
    expect(fixture.requests[0]?.text).toContain("每日重点新闻");
    expect(fixture.requests[0]?.text).toContain("https://example.com/news");
    expect((await fixture.service.overview()).subscriptions[0]).toMatchObject({
      last_run_key: "2026-08-30",
      last_delivery_status: "delivered",
      last_delivered_at: firstDelivery.last_delivered_at,
    });

    await expect(fixture.service.publish(created.credential.bearer_token, {
      ...digest, body: "同一个周期却换了正文",
    })).rejects.toBeInstanceOf(CodexScheduledDeliveryConflictError);
    await expect(fixture.service.publish(created.credential.bearer_token, {
      ...digest, run_key: "manual-second-send",
    })).rejects.toBeInstanceOf(CodexScheduledDailyLimitError);
    for (let index = 0; index < 20; index += 1) {
      await expect(fixture.service.publish(created.credential.bearer_token, {
        ...digest, run_key: `blocked-${index}`,
      })).rejects.toBeInstanceOf(CodexScheduledDailyLimitError);
    }
    expect(fixture.requests).toHaveLength(1);
    expect(StateDatabase.open(fixture.dataDir).db.query("SELECT COUNT(*) AS count FROM action_journal").get())
      .toEqual({ count: 1 });
    expect((await fixture.service.overview()).subscriptions[0]).toMatchObject({
      last_run_key: "2026-08-30",
      last_delivery_status: "delivered",
      last_delivered_at: firstDelivery.last_delivered_at,
    });

    fixture.setNow("2026-08-31T01:00:00.000Z");
    expect(await fixture.service.publish(created.credential.bearer_token, digest)).toMatchObject({
      delivered: true, replayed: true, run_key: "2026-08-30",
    });
    expect(fixture.requests).toHaveLength(1);
    expect(await fixture.service.publish(created.credential.bearer_token, {
      ...digest, run_key: "2026-08-31",
    })).toMatchObject({ delivered: true, replayed: false });
    expect(fixture.requests).toHaveLength(2);
    await expect(fixture.service.publish(created.credential.bearer_token, {
      ...digest, run_key: "manual-third-send",
    })).rejects.toBeInstanceOf(CodexScheduledDailyLimitError);
    expect((await fixture.service.overview()).subscriptions[0]).toMatchObject({
      last_run_key: "2026-08-31", last_delivery_status: "delivered",
    });
    fixture.service.revokeSubscription(created.subscription.id, created.subscription.revision);
    expect(fixture.service.authorize(created.credential.bearer_token)).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("completed journal replays repair a missing subscription projection without sending again", async () => {
  const fixture = await serviceFixture();
  try {
    const created = await fixture.service.createSubscription({ name: "每日重点新闻", target_chat_id: "-100123" });
    const digest = { run_key: "2026-08-30", title: "日报", body: "最终摘要" };
    await fixture.service.publish(created.credential.bearer_token, digest);
    StateDatabase.open(fixture.dataDir).db.query(`
      UPDATE codex_scheduled_subscriptions SET
        last_run_key=NULL,last_delivery_status='never',last_delivered_at=NULL,last_error=NULL,updated_at=?
      WHERE id=?
    `).run(created.subscription.created_at, created.subscription.id);

    expect(await fixture.service.publish(created.credential.bearer_token, digest)).toMatchObject({
      delivered: true, replayed: true,
    });
    expect(fixture.requests).toHaveLength(1);
    expect((await fixture.service.overview()).subscriptions[0]).toMatchObject({
      last_run_key: "2026-08-30", last_delivery_status: "delivered",
    });
  } finally {
    await fixture.close();
  }
});

test("a completed delivery reports projection repair without misclassifying Telegram", async () => {
  const fixture = await serviceFixture();
  try {
    const created = await fixture.service.createSubscription({ name: "每日重点新闻", target_chat_id: "-100123" });
    const state = StateDatabase.open(fixture.dataDir);
    state.db.exec(`
      CREATE TRIGGER reject_scheduled_projection
      BEFORE UPDATE ON codex_scheduled_subscriptions
      BEGIN
        SELECT RAISE(ABORT,'simulated projection failure');
      END;
    `);
    const digest = { run_key: "2026-08-30", title: "日报", body: "最终摘要" };
    expect(await fixture.service.publish(created.credential.bearer_token, digest)).toMatchObject({
      delivered: true, replayed: false, projection_pending: true,
    });
    expect(fixture.requests).toHaveLength(1);
    state.db.exec("DROP TRIGGER reject_scheduled_projection");

    expect(await fixture.service.publish(created.credential.bearer_token, digest)).toMatchObject({
      delivered: true, replayed: true,
    });
    expect(fixture.requests).toHaveLength(1);
    expect((await fixture.service.overview()).subscriptions[0]).toMatchObject({
      last_run_key: "2026-08-30", last_delivery_status: "delivered",
    });
  } finally {
    await fixture.close();
  }
});

test("uncertain Telegram results stay blocked across midnight and do not consume the new day", async () => {
  const fixture = await serviceFixture();
  try {
    const created = await fixture.service.createSubscription({ name: "每日低价好物", target_chat_id: "-100123" });
    const digest = { run_key: "2026-08-30", title: "日报", body: "最终摘要" };
    fixture.setResponder(() => new Response("Bad Gateway", { status: 502 }));
    await expect(fixture.service.publish(created.credential.bearer_token, digest))
      .rejects.toBeInstanceOf(CodexScheduledDeliveryUncertainError);
    expect(fixture.requests).toHaveLength(1);

    StateDatabase.open(fixture.dataDir).db.query(`
      UPDATE codex_scheduled_subscriptions SET
        last_run_key=NULL,last_delivery_status='never',last_delivered_at=NULL,last_error=NULL,updated_at=?
      WHERE id=?
    `).run(created.subscription.created_at, created.subscription.id);
    fixture.setNow("2026-08-31T01:00:00.000Z");
    fixture.setResponder((call) => Response.json({ ok: true, result: { message_id: call } }));
    await expect(fixture.service.publish(created.credential.bearer_token, digest))
      .rejects.toBeInstanceOf(CodexScheduledDeliveryUncertainError);
    expect(fixture.requests).toHaveLength(1);
    expect((await fixture.service.overview()).subscriptions[0]).toMatchObject({
      last_run_key: "2026-08-30", last_delivery_status: "uncertain",
    });

    expect(await fixture.service.publish(created.credential.bearer_token, {
      ...digest, run_key: "2026-08-31",
    })).toMatchObject({ delivered: true, replayed: false });
    expect(fixture.requests).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("concurrent run keys atomically share one daily delivery slot", async () => {
  const fixture = await serviceFixture();
  try {
    const created = await fixture.service.createSubscription({ name: "每日重点新闻", target_chat_id: "-100123" });
    const results = await Promise.allSettled([
      fixture.service.publish(created.credential.bearer_token, {
        run_key: "2026-08-30-a", title: "日报 A", body: "最终摘要 A",
      }),
      fixture.service.publish(created.credential.bearer_token, {
        run_key: "2026-08-30-b", title: "日报 B", body: "最终摘要 B",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
      reason: expect.any(CodexScheduledDailyLimitError),
    });
    expect(fixture.requests).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("scheduled subscriptions are opt-in, target-checked, and capped at three", async () => {
  const fixture = await serviceFixture();
  try {
    expect((await fixture.service.overview()).subscriptions).toEqual([]);
    await expect(fixture.service.createSubscription({ name: "wrong", target_chat_id: "-100999" }))
      .rejects.toBeInstanceOf(CodexScheduledDeliveryConfigurationError);
    for (let index = 1; index <= 3; index += 1) {
      await fixture.service.createSubscription({ name: `任务 ${index}`, target_chat_id: "-100123" });
    }
    await expect(fixture.service.createSubscription({ name: "任务 4", target_chat_id: "-100123" }))
      .rejects.toBeInstanceOf(CodexScheduledSubscriptionLimitError);
  } finally {
    await fixture.close();
  }
});

test("scheduled Telegram digest remains one bounded message and marks truncation", () => {
  const text = formatTelegramDigest("每日低价好物", {
    run_key: "2026-08-30",
    title: "今日值得买",
    body: "商品信息".repeat(2_000),
    source_urls: ["https://example.com/" + "a".repeat(800)],
  });
  expect(text.length).toBeLessThanOrEqual(4_000);
  expect(text).toContain("按 Telegram 单条消息上限截断");
  expect(text).toContain("来源");
});

async function serviceFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-codex-scheduled-"));
  const secrets = join(dataDir, "secrets");
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, "telegram-bot-token"), "123456:test_token\n");
  await writeFile(join(secrets, "telegram-chat-ids"), "-100123\n");
  const requests: Array<{ chat_id: string; text: string }> = [];
  let now = new Date("2026-08-30T01:00:00.000Z");
  let responder = (call: number): Response => Response.json({ ok: true, result: { message_id: call } });
  const service = new CodexScheduledDeliveryService({
    dataDir,
    publicBaseUrl: "https://totemora.example/base",
    fetchImpl: (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return responder(requests.length);
    }) as typeof fetch,
    now: () => now,
  });
  return {
    dataDir,
    service,
    requests,
    setNow: (value: string) => { now = new Date(value); },
    setResponder: (value: (call: number) => Response) => { responder = value; },
    close: () => rm(dataDir, { recursive: true, force: true }),
  };
}
