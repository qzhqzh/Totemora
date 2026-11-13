import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../../server/src/state-database";
import { migrateGatewayNotifications } from "./migrate-from-gateway";
import { NotifierDatabase } from "./storage";

test("offline cutover preserves event IDs and notification receipts; repeated import is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "totemora-notifier-upgrade-"));
  try {
    const sourceDir = join(dir, "gateway");
    const dataDir = join(dir, "notifier");
    const source = StateDatabase.open(sourceDir).db;
    const now = new Date().toISOString();
    source.query(`INSERT INTO external_notification_events(event_uuid,source_id,external_id,type,payload_hash,
      title,body,priority,occurred_at,route_targets_json,status,attempts,created_at,updated_at)
      VALUES('event-1','backup','run-1','backup.failed',?,'Error','Disk offline',3,?,?,'sending',1,?,?)`)
      .run("a".repeat(64), now, JSON.stringify(["bark:phone"]), now, now);
    source.query(`INSERT INTO action_journal(id,idempotency_key,asset_id,member_id,action,request_hash,
      status,attempts,started_at,updated_at,evidence) VALUES('action-1','notification:backup:phone',
      'bark-notification','notification-ingress','push_notification',?,'completed',1,?,?,?)`)
      .run("b".repeat(64), now, now, "Bark accepted");
    const input = { sourcePath: join(sourceDir, "totemora.db"), dataDir };
    expect(migrateGatewayNotifications(input)).toEqual({ events: 1, actions: 1, applied: false });
    expect(migrateGatewayNotifications({ ...input, apply: true })).toEqual({ events: 1, actions: 1, applied: true });
    const target = NotifierDatabase.open(dataDir).db;
    expect(target.query("SELECT status FROM external_notification_events WHERE event_uuid='event-1'").get())
      .toMatchObject({ status: "uncertain" });
    expect(target.query("SELECT evidence FROM action_journal WHERE id='action-1'").get())
      .toMatchObject({ evidence: "Bark accepted" });
    expect(migrateGatewayNotifications({ ...input, apply: true }).applied).toBe(true);
    source.query("UPDATE external_notification_events SET title='different' WHERE event_uuid='event-1'").run();
    expect(() => migrateGatewayNotifications({ ...input, apply: true })).toThrow("conflicts");
    expect(target.query("SELECT count(*) as count FROM external_notification_events").get()).toMatchObject({ count: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
