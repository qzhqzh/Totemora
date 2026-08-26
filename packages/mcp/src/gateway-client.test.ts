import { expect, test } from "bun:test";

import { TotemoraGatewayClient } from "./gateway-client";

test("Gateway client rejects chunked responses above its byte budget", async () => {
  let cancelled = false;
  const client = new TotemoraGatewayClient({
    gatewayUrl: "http://gateway.local",
    operatorToken: "operator",
    fetch: (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }))) as unknown as typeof fetch,
  });

  await expect(client.listAssets()).rejects.toThrow("Totemora Gateway response exceeds 2 MiB");
  expect(cancelled).toBe(true);
});

test("Gateway client reports invalid JSON without leaking response text", async () => {
  const client = new TotemoraGatewayClient({
    gatewayUrl: "http://gateway.local",
    operatorToken: "operator",
    fetch: (async () => new Response("<html>upstream failed</html>", { status: 502 })) as unknown as typeof fetch,
  });

  await expect(client.listAssets()).rejects.toThrow("Totemora Gateway returned invalid JSON (502)");
});
