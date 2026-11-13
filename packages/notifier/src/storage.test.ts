import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotifierDatabase } from "./storage";

test("initial migration is repeatable and does not leave partial new tables on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notifier-migration-"));
  try {
    const path = join(dir, "notifier.db");
    const prior = new Database(path);
    prior.exec("CREATE TABLE external_notification_events(event_uuid TEXT PRIMARY KEY)");
    prior.query("INSERT INTO external_notification_events(event_uuid) VALUES('legacy')").run();
    prior.close();
    expect(() => NotifierDatabase.open(dir)).toThrow("external_notification_events");
    const after = new Database(path);
    expect(after.query("SELECT count(*) as count FROM external_notification_events").get()).toMatchObject({ count: 1 });
    expect(after.query("SELECT name FROM sqlite_master WHERE name='action_journal'").get()).toBeNull();
    expect(after.query("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()).toBeNull();
    after.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
