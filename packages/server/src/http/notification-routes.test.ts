import { expect, test } from "bun:test";

import type { BarkNotificationService, BarkTargetMutationInput } from "../bark-notification-service";
import { HttpError } from "./http-boundary";
import { handleNotificationRoutes } from "./notification-routes";

test("notification routes protect reads and validate health and target mutations", async () => {
  const mutations: Array<{ input: BarkTargetMutationInput; mode: string }> = [];
  const management = {
    async managementStatus(health: boolean) {
      return { configured: false, channel_status: "unconfigured" as const, consecutive_failures: 0, targets: [], write_enabled: true, health };
    },
    async upsertManagedTarget(input: BarkTargetMutationInput, mode: "create" | "update" | "upsert") {
      mutations.push({ input, mode });
      return { id: input.id, server_url: String(input.server_url), domains: ["ai" as const], enabled: true };
    },
    async listManagementAudit() { return []; },
  } satisfies Pick<BarkNotificationService, "managementStatus" | "upsertManagedTarget" | "listManagementAudit">;
  const handle = (request: Request) => handleNotificationRoutes(request, new URL(request.url), {
    management,
    async testTarget() { return { accepted: true, replayed: false }; },
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw new HttpError(401, "Operator authorization failed");
      }
    },
  });

  await expect(handle(new Request("http://local/api/notifications/bark/targets")))
    .rejects.toMatchObject({ status: 401 });
  await expect(handle(new Request("http://local/api/notifications/bark/targets?health=yes", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toMatchObject({ status: 400 });

  const invalid = new Request("http://local/api/notifications/bark/targets", {
    method: "POST",
    headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ id: "phone", device_key: "has space", domains: ["ai"] }),
  });
  await expect(handle(invalid)).rejects.toMatchObject({ status: 400 });

  const created = await handle(new Request("http://local/api/notifications/bark/targets", {
    method: "POST",
    headers: { authorization: "Bearer operator" },
    body: JSON.stringify({
      id: "phone-2", label: "Second phone", device_key: "device-key-1234",
      domains: ["reminder"], enabled: true, server_url: "https://bark.example.com",
    }),
  }));
  expect(created?.status).toBe(201);
  expect(mutations).toEqual([{ mode: "create", input: {
    id: "phone-2", label: "Second phone", device_key: "device-key-1234",
    domains: ["reminder"], enabled: true, server_url: "https://bark.example.com",
  } }]);
});

test("notification test routes bound JSON and idempotency input", async () => {
  const tested: Array<{ id: string; key?: string }> = [];
  const handle = (request: Request) => handleNotificationRoutes(request, new URL(request.url), {
    management: {
      async managementStatus() { return { configured: false, channel_status: "unconfigured", consecutive_failures: 0, targets: [], write_enabled: true }; },
      async upsertManagedTarget() { throw new Error("not used"); },
      async listManagementAudit() { return []; },
    } as never,
    async testTarget(id, key) {
      tested.push({ id, key });
      return { accepted: true, replayed: false };
    },
    requireOperator() {},
  });

  await expect(handle(new Request("http://local/api/notifications/bark/targets/phone/test", {
    method: "POST", body: JSON.stringify({ idempotency_key: 42 }),
  }))).rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/notifications/bark/targets/phone/test", {
    method: "POST", body: JSON.stringify({ idempotency_key: "x".repeat(5_000) }),
  }))).rejects.toMatchObject({ status: 413 });

  const response = await handle(new Request("http://local/api/notifications/bark/targets/phone%2D2/test", {
    method: "POST", body: JSON.stringify({ idempotency_key: "test-1" }),
  }));
  expect(await response?.json()).toEqual({ target_id: "phone-2", accepted: true, replayed: false });
  expect(tested).toEqual([{ id: "phone-2", key: "test-1" }]);
});
