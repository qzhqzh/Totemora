import { expect, test } from "bun:test";

import { CodexScheduledSubscriptionLimitError } from "../application/codex-scheduled-delivery-service";
import { handleCodexScheduledRoutes, type CodexScheduledRouteService } from "./codex-scheduled-routes";
import { HttpError } from "./http-boundary";

test("scheduled subscription routes require operator auth and return one-time connection material", async () => {
  const calls: unknown[] = [];
  const service = fakeService({
    createSubscription: async (input) => {
      calls.push(input);
      return {
        subscription: subscription(),
        credential: {
          mcp_endpoint: "https://totemora.example/mcp/codex-scheduled",
          bearer_token: "only-once",
          tool_name: "publish_scheduled_digest",
          prompt: "publish after completion",
        },
      };
    },
  });
  await expect(handle(new Request("http://local/api/codex/scheduled-subscriptions"), service))
    .rejects.toMatchObject({ status: 401 });
  const response = await handle(new Request("http://local/api/codex/scheduled-subscriptions", {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify({ name: "每日新闻", target_chat_id: "-100123" }),
  }), service);
  expect(response?.status).toBe(201);
  expect(await response?.json()).toMatchObject({ credential: { bearer_token: "only-once" } });
  expect(calls).toEqual([{ name: "每日新闻", target_chat_id: "-100123" }]);
});

test("scheduled subscription routes preserve optimistic revocation and conflict semantics", async () => {
  const calls: unknown[] = [];
  const service = fakeService({
    revokeSubscription: (id, expectedRevision) => {
      calls.push({ id, expectedRevision });
      return { ...subscription(), id, status: "revoked", revision: expectedRevision + 1 };
    },
  });
  const response = await handle(new Request("http://local/api/codex/scheduled-subscriptions/sub-1", {
    method: "DELETE", headers: authorized(), body: JSON.stringify({ expected_revision: 2 }),
  }), service);
  expect(response?.status).toBe(200);
  expect(calls).toEqual([{ id: "sub-1", expectedRevision: 2 }]);

  const limited = fakeService({
    createSubscription: async () => { throw new CodexScheduledSubscriptionLimitError("最多三个"); },
  });
  await expect(handle(new Request("http://local/api/codex/scheduled-subscriptions", {
    method: "POST", headers: authorized(), body: JSON.stringify({ name: "第四个", target_chat_id: "-100123" }),
  }), limited)).rejects.toMatchObject({ status: 409 });
});

function handle(request: Request, service: CodexScheduledRouteService) {
  return handleCodexScheduledRoutes(request, new URL(request.url), {
    service,
    requireOperator: (candidate) => {
      if (candidate.headers.get("authorization") !== "Bearer operator") throw new HttpError(401, "unauthorized");
    },
  });
}

function fakeService(overrides: Partial<CodexScheduledRouteService>): CodexScheduledRouteService {
  return {
    overview: async () => ({
      subscriptions: [], subscription_limit: 3, telegram_targets: [{ chat_id: "-100123" }],
      mcp_endpoint: "https://totemora.example/mcp/codex-scheduled",
    }),
    createSubscription: async () => ({
      subscription: subscription(),
      credential: {
        mcp_endpoint: "https://totemora.example/mcp/codex-scheduled",
        bearer_token: "token",
        tool_name: "publish_scheduled_digest",
        prompt: "prompt",
      },
    }),
    revokeSubscription: () => subscription(),
    ...overrides,
  };
}

function subscription() {
  return {
    id: "sub-1", name: "每日新闻", target_chat_id: "-100123", status: "active" as const,
    last_delivery_status: "never" as const, revision: 1,
    created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z",
  };
}

function authorized(): HeadersInit {
  return { authorization: "Bearer operator", "content-type": "application/json" };
}
