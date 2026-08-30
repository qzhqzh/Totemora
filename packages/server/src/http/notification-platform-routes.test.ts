import { expect, test } from "bun:test";

import type { NotificationPlatformRouteService } from "./notification-platform-routes";
import { handleNotificationPlatformRoutes } from "./notification-platform-routes";
import { HttpError } from "./http-boundary";

test("notification platform status is operator-only and exposes public target aliases", async () => {
  const service: NotificationPlatformRouteService = {
    async listTargets() {
      return [{ id: "daily-news", channel: "telegram", domains: ["ai"], enabled: true, label: "Daily news" }];
    },
    async dispatch() { throw new Error("not used"); },
  };
  const handle = (request: Request) => handleNotificationPlatformRoutes(request, new URL(request.url), {
    service,
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw new HttpError(401, "Operator authorization failed");
      }
    },
  });

  await expect(handle(new Request("http://local/api/notifications/platform")))
    .rejects.toMatchObject({ status: 401 });
  const response = await handle(new Request("http://local/api/notifications/platform", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await response?.json()).toMatchObject({
    schema_version: 1,
    state: "configured",
    supported_channels: ["bark", "telegram", "ntfy"],
    targets: [{ id: "daily-news", channel: "telegram" }],
  });
});

test("notification platform test creates a bounded idempotent server-authored envelope", async () => {
  const dispatched: Array<{ envelope: unknown; member_id: string }> = [];
  const service: NotificationPlatformRouteService = {
    async listTargets() { return []; },
    async dispatch(input) {
      dispatched.push(input);
      return {
        envelope_id: "notification-test:hash",
        idempotency_key: "operator-test:qa-1",
        status: "completed",
        deliveries: [{ target_id: "ops-topic", channel: "ntfy", status: "completed" }],
      };
    },
  };
  const handle = (request: Request) => handleNotificationPlatformRoutes(request, new URL(request.url), {
    service,
    requireOperator() {},
  });

  await expect(handle(new Request("http://local/api/notifications/platform/test", {
    method: "POST",
    body: JSON.stringify({ domain: "ops", target_channels: [], idempotency_key: "qa-1" }),
  }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/notifications/platform/test", {
    method: "POST",
    body: JSON.stringify({
      domain: "ops",
      target_channels: ["ntfy"],
      idempotency_key: "qa-1",
      body: "caller-controlled content is forbidden",
    }),
  }))).rejects.toMatchObject({ status: 400 });
  const response = await handle(new Request("http://local/api/notifications/platform/test", {
    method: "POST",
    body: JSON.stringify({
      domain: "ops", target_channels: ["ntfy", "ntfy"], idempotency_key: "qa-1",
    }),
  }));
  expect((await response?.json() as { status: string }).status).toBe("completed");
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.member_id).toBe("operator");
  expect(dispatched[0]?.envelope).toMatchObject({
    schema_version: 1,
    idempotency_key: "operator-test:qa-1",
    domain: "ops",
    kind: "status",
    target_channels: ["ntfy"],
  });
  expect(JSON.stringify(dispatched[0]?.envelope)).not.toContain("caller-controlled content");
});
