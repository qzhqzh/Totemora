import { expect, test } from "bun:test";

import { handleForwardedRoutes } from "./forwarded-routes";

const service = {
  list(status: string, limit: number) { return [{ id: "forwarded-1", status, limit }]; },
  async status() {
    return {
      configured: true,
      counts: { pending: 0, completed: 1, failed: 0, uncertain: 0, deduped: 2 },
    };
  },
};

test("forwarded routes protect relay evidence and bound filters", async () => {
  const handle = (request: Request) => handleForwardedRoutes(request, new URL(request.url), {
    service,
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
      }
    },
  });
  await expect(handle(new Request("http://local/api/forwarded"))).rejects.toThrow("Unauthorized");
  const listed = await handle(new Request("http://local/api/forwarded?status=completed&limit=20", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await listed?.json()).toEqual({
    status: "completed",
    events: [{ id: "forwarded-1", status: "completed", limit: 20 }],
  });
  const status = await handle(new Request("http://local/api/forwarded/status", {
    headers: { authorization: "Bearer operator" },
  }));
  expect(await status?.json()).toMatchObject({ configured: true, counts: { completed: 1 } });
  await expect(handle(new Request("http://local/api/forwarded?status=future", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toThrow("status must be");
  await expect(handle(new Request("http://local/api/forwarded?limit=101", {
    headers: { authorization: "Bearer operator" },
  }))).rejects.toThrow("limit must be 1-100");
});
