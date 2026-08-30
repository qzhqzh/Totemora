import { expect, test } from "bun:test";

import { parseNotificationEnvelope } from "../domains/notification/notification-envelope";
import {
  LEGACY_NTFY_TOPICS,
  NtfyDeliveryError,
  NtfyNotificationClient,
} from "./ntfy-notification-client";

const envelope = parseNotificationEnvelope({
  schema_version: 1,
  id: "reminder:42:window-1",
  idempotency_key: "reminder:42:window-1:target",
  domain: "reminder",
  kind: "reminder",
  title: "事项提醒",
  body: "今天需要处理的事项",
  priority: 4,
  tags: ["alarm_clock", "memo"],
  source: {
    source_id: "legacy:memo:42",
    url: "https://example.test/reminders/42",
  },
  image_url: "https://example.test/reminder.png",
});

test("publishes the public envelope fields and returns a verified ntfy receipt", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = new NtfyNotificationClient([{
    id: "memo-topic",
    server_url: "https://ntfy.example.test",
    topic: "memo",
    authorization: "Bearer runtime-secret",
  }], (async (input, init) => {
    request = { url: String(input), init };
    return Response.json({
      id: "nTFyMessage01",
      time: 1_787_968_800,
      event: "message",
      topic: "memo",
      message: envelope.body,
    });
  }) as typeof fetch);

  await expect(client.publish("memo-topic", envelope)).resolves.toEqual({
    accepted: true,
    target_id: "memo-topic",
    topic: "memo",
    message_id: "nTFyMessage01",
    status: 200,
  });
  expect(request?.url).toBe("https://ntfy.example.test/");
  expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer runtime-secret");
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    topic: "memo",
    title: "事项提醒",
    message: "今天需要处理的事项",
    priority: 4,
    tags: ["alarm_clock", "memo"],
    click: "https://example.test/reminders/42",
    icon: "https://example.test/reminder.png",
  });
});

test("marks a network failure uncertain and redacts authorization", async () => {
  const authorization = "Basic very-secret-credential";
  const client = new NtfyNotificationClient([{
    id: "memo-topic",
    server_url: "http://127.0.0.1:40011",
    topic: "memo",
    authorization,
  }], (async () => Promise.reject(new Error(`socket closed after ${authorization}`))) as unknown as typeof fetch);

  const error = await rejected(client.publish("memo-topic", envelope));
  expect(error).toBeInstanceOf(NtfyDeliveryError);
  expect(error).toMatchObject({ retryable: true, outcomeUncertain: true, targetId: "memo-topic" });
  expect(error.message).not.toContain("very-secret-credential");
});

test("distinguishes a structured ntfy rejection from an ambiguous server response", async () => {
  const structured = new NtfyNotificationClient([target()], (async () => Response.json({
    code: 50001,
    http: 503,
    error: "temporarily unavailable",
  }, { status: 503 })) as unknown as typeof fetch);
  const ambiguous = new NtfyNotificationClient([target()], (async () => new Response(
    "proxy closed the upstream connection",
    { status: 503 },
  )) as unknown as typeof fetch);

  expect(await rejected(structured.publish("memo-topic", envelope))).toMatchObject({
    retryable: true,
    status: 503,
    outcomeUncertain: false,
  });
  expect(await rejected(ambiguous.publish("memo-topic", envelope))).toMatchObject({
    retryable: true,
    status: 503,
    outcomeUncertain: true,
  });
});

test("treats an invalid successful response as uncertain", async () => {
  const client = new NtfyNotificationClient([target()], (async () => Response.json({
    event: "message",
    topic: "memo",
  })) as unknown as typeof fetch);

  expect(await rejected(client.publish("memo-topic", envelope))).toMatchObject({
    status: 200,
    outcomeUncertain: true,
  });
});

test("rejects insecure remote endpoints and oversized messages before sending", async () => {
  expect(() => new NtfyNotificationClient([{
    id: "memo-topic",
    server_url: "http://ntfy.example.test",
    topic: "memo",
  }])).toThrow("HTTPS or loopback HTTP");

  let calls = 0;
  const client = new NtfyNotificationClient([target()], (async () => {
    calls += 1;
    return Response.json({});
  }) as unknown as typeof fetch);
  const error = await rejected(client.publish("memo-topic", {
    ...envelope,
    body: "中".repeat(1_267),
  }));
  expect(error).toMatchObject({ retryable: false, status: 413, outcomeUncertain: false });
  expect(calls).toBe(0);
});

test("keeps the legacy six-topic mapping while adding an ops topic", () => {
  expect(LEGACY_NTFY_TOPICS).toEqual({
    ai: "hotspot",
    finance: "finance",
    reminder: "memo",
    deals: "deals",
    forwarded: "forwarded",
    content: "x",
    ops: "ops",
  });
});

function target() {
  return {
    id: "memo-topic",
    server_url: "https://ntfy.example.test",
    topic: "memo",
  };
}

async function rejected(promise: Promise<unknown>): Promise<NtfyDeliveryError> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    if (error instanceof NtfyDeliveryError) return error;
    throw error;
  }
}
