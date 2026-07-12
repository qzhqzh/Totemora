import { expect, test } from "bun:test";

import { AnthropicCompatibleProvider } from "./anthropic-compatible";

test("calls an Anthropic-compatible messages endpoint", async () => {
  let receivedUrl = "";
  let receivedHeaders = new Headers();
  let receivedBody: Record<string, unknown> = {};
  const provider = new AnthropicCompatibleProvider(
    {
      id: "xiaomi",
      baseUrl: "https://example.test/anthropic",
      apiKey: "test-token",
    },
    async (input, init) => {
      receivedUrl = String(input);
      receivedHeaders = new Headers(init?.headers);
      receivedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "READY" }],
          usage: { input_tokens: 8, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const response = await provider.generate({
    memberId: "mimo_scout",
    model: "mimo-v2.5-pro",
    messages: [
      { role: "system", content: "你是侦察员" },
      { role: "user", content: "检查状态" },
    ],
    maxTokens: 128,
  });

  expect(receivedUrl).toBe("https://example.test/anthropic/v1/messages");
  expect(receivedHeaders.get("x-api-key")).toBe("test-token");
  expect(receivedHeaders.get("anthropic-version")).toBe("2023-06-01");
  expect(receivedBody.system).toBe("你是侦察员");
  expect(receivedBody.messages).toEqual([
    { role: "user", content: "检查状态" },
  ]);
  expect(response.content).toBe("READY");
  expect(response.usage?.totalTokens).toBe(10);
});

test("explains an empty response caused by the output token limit", async () => {
  const provider = new AnthropicCompatibleProvider(
    { id: "deepseek", baseUrl: "https://example.test", apiKey: "test-token" },
    async () => new Response(JSON.stringify({
      content: [{ type: "thinking", thinking: "hidden" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 20, output_tokens: 3000 },
    })),
  );
  await expect(provider.generate({
    memberId: "deepseek_reasoner", model: "deepseek", messages: [], maxTokens: 3000,
  })).rejects.toThrow("stop_reason=max_tokens, blocks=thinking, output_tokens=3000");
});
