import { expect, test } from "bun:test";

import { readBoundedResponseText } from "./bounded-response";

test("server integrations limit bytes while streaming external responses", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("四个字"));
    },
    cancel() {
      cancelled = true;
    },
  }));

  await expect(readBoundedResponseText(response, 20, "external response too large"))
    .rejects.toThrow("external response too large");
  expect(cancelled).toBe(true);
});
