import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActionJournal } from "./action-journal";
import { NotifierDatabase } from "./storage";

const input = { idempotency_key: "notification:abc:bark:phone", asset_id: "bark-notification",
  member_id: "backup", action: "push_notification", request: { title: "Failure" } };

test("a concurrent replay cannot invalidate the active lease or send twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notifier-journal-concurrency-"));
  try {
    const journal = new ActionJournal(dir);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = journal.executeEffectOnce(input, async () => { calls += 1; await waiting; return "accepted"; });
    await expect(journal.executeEffectOnce(input, async () => { calls += 1; return "duplicate"; }))
      .rejects.toThrow("uncertain");
    release();
    expect(await first).toMatchObject({ replayed: false, record: { evidence: "accepted" } });
    expect(await journal.executeEffectOnce(input, async () => { calls += 1; return "duplicate"; }))
      .toMatchObject({ replayed: true });
    expect(calls).toBe(1);
    expect(NotifierDatabase.open(dir).db.query("SELECT status FROM action_journal WHERE idempotency_key=?")
      .get(input.idempotency_key)).toMatchObject({ status: "completed" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("expired in-flight record becomes uncertain, never replays a possible send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notifier-journal-restart-"));
  try {
    const db = NotifierDatabase.open(dir).db;
    db.query(`INSERT INTO action_journal(id,idempotency_key,asset_id,member_id,action,request_hash,
      status,attempts,lease_token,lease_expires_at,started_at,updated_at)
      VALUES('a',?,?,?,?,?,'executing',1,'old-lease',?,?,?)`)
      .run(input.idempotency_key, input.asset_id, input.member_id, input.action,
        createHash("sha256").update(JSON.stringify(input.request)).digest("hex"), "2020-01-01", "2020-01-01", "2020-01-01");
    let called = false;
    const journal = new ActionJournal(dir);
    await expect(journal.executeEffectOnce(input, async () => { called = true; return "should not run"; }))
      .rejects.toThrow("uncertain");
    expect(called).toBe(false);
    expect(db.query("SELECT status FROM action_journal WHERE id='a'").get()).toMatchObject({ status: "uncertain" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
