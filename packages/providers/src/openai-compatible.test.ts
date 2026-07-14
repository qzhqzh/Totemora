import { expect, test } from "bun:test";

import { OpenAICompatibleProvider } from "./openai-compatible";

test("calls an OpenAI-compatible chat completion and normalizes usage", async () => {
  let receivedUrl = "";
  let receivedInit: RequestInit | undefined;
  const provider = new OpenAICompatibleProvider(
    {
      id: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
    },
    async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "done" } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const result = await provider.generate({
    memberId: "deepseek_reasoner",
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hello" }],
    responseFormat: "json",
  });

  expect(receivedUrl).toBe("https://api.deepseek.com/chat/completions");
  expect(new Headers(receivedInit?.headers).get("authorization")).toBe(
    "Bearer test-key",
  );
  expect(JSON.parse(String(receivedInit?.body)).response_format).toEqual({
    type: "json_object",
  });
  expect(result.content).toBe("done");
  expect(result.usage?.totalTokens).toBe(14);
});

test("fails before the request when the provider API key is missing", async () => {
  const provider = new OpenAICompatibleProvider({
    id: "qwen",
    baseUrl: "https://example.test/v1",
    apiKey: "",
  });

  await expect(
    provider.generate({
      memberId: "qwen_worker",
      model: "qwen3.7-plus",
      messages: [{ role: "user", content: "hello" }],
    }),
  ).rejects.toThrow("Missing API key for provider: qwen");
});
