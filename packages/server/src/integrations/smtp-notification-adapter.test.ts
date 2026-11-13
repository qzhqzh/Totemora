import { expect, test } from "bun:test";

import { parseNotificationEnvelope } from "../domains/notification/notification-envelope";
import { SmtpNotificationAdapter } from "./smtp-notification-adapter";

const smtp = {
  host: "smtp.example.test", port: 587, secure: false,
  user: "smtp-user", password: "private-password", from: "sender@example.test",
};
const targets = [{ id: "owner", address: "owner@example.test", enabled: true }];
const target = { id: "owner", channel: "email" as const, enabled: true, domains: ["ops" as const] };
const envelope = parseNotificationEnvelope({
  schema_version: 1, id: "external:test", idempotency_key: "external:test",
  domain: "ops", kind: "status", title: "Backup failed", body: "Storage offline",
  priority: 4, tags: [],
});

test("SMTP adapter sends text only to the server-configured recipient", async () => {
  const sent: unknown[] = [];
  const adapter = new SmtpNotificationAdapter(smtp, targets, async (message) => {
    sent.push(message);
    return { accepted: [message.to], messageId: "email-1" };
  });
  expect(await adapter.deliver(target, envelope)).toEqual({ accepted: true, evidence: "SMTP accepted email-1" });
  expect(sent).toEqual([{
    from: "sender@example.test", to: "owner@example.test",
    subject: "Backup failed", text: "Storage offline", disableFileAccess: true, disableUrlAccess: true,
  }]);
  expect(JSON.stringify(sent)).not.toContain(smtp.password);
  await expect(adapter.deliver({ ...target, id: "unconfigured" }, envelope)).rejects.toThrow("unavailable");
});

test("ambiguous SMTP failure is treated as uncertain, never automatically retried", async () => {
  const adapter = new SmtpNotificationAdapter(smtp, targets, async () => { throw new Error("network dropped after DATA"); });
  await expect(adapter.deliver(target, envelope)).rejects.toMatchObject({ outcomeUncertain: true });
});
