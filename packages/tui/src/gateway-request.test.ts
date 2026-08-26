import { expect, test } from "bun:test";

import { requestGatewayJson } from "./gateway-request";

test("TUI Gateway requests reject chunked responses above the byte budget", async () => {
  let cancelled = false;
  await expect(requestGatewayJson(
    async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    })),
    "http://gateway.local/api/status",
  )).rejects.toThrow("Gateway response exceeds 2 MiB");
  expect(cancelled).toBe(true);
});

test("TUI Gateway requests preserve bounded API errors", async () => {
  await expect(requestGatewayJson(
    async () => Response.json({ error: "Operator authorization failed" }, { status: 401 }),
    "http://gateway.local/api/runs",
  )).rejects.toThrow("Operator authorization failed");
});
