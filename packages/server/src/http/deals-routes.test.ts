import { expect, test } from "bun:test";

import { handleDealsRoutes } from "./deals-routes";

const service = {
  list(status: string, limit: number) { return [{ id: "deal-1", status, limit }]; },
  status() { return { counts: { pending: 0, delivered: 1, uncertain: 0, skipped: 2 } }; },
};

test("deals routes protect evidence and bound filters", async () => {
  const handle = (request: Request) => handleDealsRoutes(request, new URL(request.url), {
    service,
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") throw Object.assign(new Error("Unauthorized"), { status: 401 });
    },
  });
  await expect(handle(new Request("http://local/api/deals"))).rejects.toThrow("Unauthorized");
  const listed = await handle(new Request("http://local/api/deals?status=delivered&limit=20", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await listed?.json()).toEqual({ status: "delivered", deals: [{ id: "deal-1", status: "delivered", limit: 20 }] });
  const status = await handle(new Request("http://local/api/deals/status", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await status?.json()).toMatchObject({ counts: { delivered: 1 } });
  await expect(handle(new Request("http://local/api/deals?status=future", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toThrow("status must be");
  await expect(handle(new Request("http://local/api/deals?limit=101", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toThrow("limit must be 1-100");
});
