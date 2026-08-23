import { expect, test } from "bun:test";

import { HttpError } from "./http-boundary";
import { handleContentRoutes, type ContentRouteService } from "./content-routes";

test("content routes protect work records and validate create input", async () => {
  const enqueued: unknown[] = [];
  const content = contentService();
  const handle = (request: Request) => handleContentRoutes(request, new URL(request.url), {
    async getContent() { return content; },
    async enqueue(input) { enqueued.push(input); return { id: "work-2" } as any; },
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw new HttpError(401, "Operator authorization failed");
      }
    },
  });

  await expect(handle(new Request("http://local/api/content/works")))
    .rejects.toMatchObject({ status: 401 });
  await expect(handle(new Request("http://local/api/content/works", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ format: "unsupported", topic: "hello" }),
  }))).rejects.toMatchObject({ status: 400 });

  const created = await handle(new Request("http://local/api/content/works", {
    method: "POST", headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ format: "x_hot_post", topic: "hello" }),
  }));
  expect(created?.status).toBe(202);
  expect(enqueued).toEqual([{ format: "x_hot_post", topic: "hello" }]);
});

test("content routes bound preferences, list limits, and missing works", async () => {
  const content = contentService();
  const dependencies = {
    async getContent() { return content; },
    async enqueue() { return { id: "work-2" } as any; },
    requireOperator() {},
  };
  const handle = (request: Request) => handleContentRoutes(request, new URL(request.url), dependencies);

  const preferences = await handle(new Request("http://local/api/content/preferences"));
  expect(await preferences?.json()).toEqual({ enabled: true });
  await expect(handle(new Request("http://local/api/content/works?limit=all")))
    .rejects.toMatchObject({ status: 400 });
  await expect(handle(new Request("http://local/api/content/preferences", {
    method: "PUT", body: JSON.stringify({ formats: ["x_hot_post", "unknown"] }),
  }))).rejects.toMatchObject({ status: 400 });
  const missing = await handle(new Request("http://local/api/content/works/missing"));
  expect(missing?.status).toBe(404);
});

function contentService(): ContentRouteService {
  return {
    list() { return [] as any; },
    preferences() { return { enabled: true } as any; },
    savePreferences(input) { return input as any; },
    async markCopied(id) { return { id } as any; },
    get(id) { return id === "missing" ? undefined : { id, status: "ready", body: "ready" } as any; },
    async retryIllustration(id) { return { id } as any; },
    async readIllustration() { return undefined; },
  };
}
