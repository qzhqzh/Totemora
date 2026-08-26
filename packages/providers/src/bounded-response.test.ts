import { expect, test } from "bun:test";

import { AnthropicCompatibleProvider } from "./anthropic-compatible";
import { readBoundedResponseText } from "./bounded-response";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { OpenAIResponsesProvider } from "./openai-responses";

test("bounded provider responses stop chunked bodies at the byte limit", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(6));
    },
    cancel() {
      cancelled = true;
    },
  }));

  await expect(readBoundedResponseText(response, 10, "provider response too large"))
    .rejects.toThrow("provider response too large");
  expect(cancelled).toBe(true);
});

test("bounded provider responses reject oversized declared bodies before reading", async () => {
  const response = new Response("small", { headers: { "content-length": "100" } });
  await expect(readBoundedResponseText(response, 10, "provider response too large"))
    .rejects.toThrow("provider response too large");
});

for (const [name, provider] of [
  ["OpenAI-compatible", new OpenAICompatibleProvider(
    { id: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "key" },
    oversizedResponse,
  )],
  ["Anthropic-compatible", new AnthropicCompatibleProvider(
    { id: "anthropic-compatible", baseUrl: "https://provider.test", apiKey: "key" },
    oversizedResponse,
  )],
  ["OpenAI Responses", new OpenAIResponsesProvider(
    { id: "openai-responses", baseUrl: "https://provider.test/v1", apiKey: "key" },
    oversizedResponse,
  )],
] as const) {
  test(`${name} adapter applies the model response byte budget`, async () => {
    await expect(provider.generate({
      memberId: "member", model: "model", messages: [{ role: "user", content: "test" }],
    })).rejects.toThrow("response exceeds 4 MiB");
  });
}

async function oversizedResponse(): Promise<Response> {
  return new Response("{}", { headers: { "content-length": String(4 * 1024 * 1024 + 1) } });
}
