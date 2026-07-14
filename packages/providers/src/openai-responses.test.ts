import { expect, test } from "bun:test";

import { OpenAIResponsesProvider } from "./openai-responses";

test("calls the OpenAI Responses API and extracts output text", async () => {
  let receivedUrl = "";
  let receivedBody: Record<string, unknown> = {};
  const provider = new OpenAIResponsesProvider(
    {
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
    },
    async (input, init) => {
      receivedUrl = String(input);
      receivedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"status":"ready"}' }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const result = await provider.generate({
    memberId: "gpt_chief",
    model: "gpt-5.6",
    messages: [
      { role: "system", content: "lead" },
      { role: "user", content: "plan" },
    ],
    responseFormat: "json",
    maxTokens: 300,
  });

  expect(receivedUrl).toBe("https://api.openai.com/v1/responses");
  expect(receivedBody.store).toBe(false);
  expect(receivedBody.max_output_tokens).toBe(300);
  expect(receivedBody.text).toEqual({ format: { type: "json_object" } });
  expect(result.content).toBe('{"status":"ready"}');
  expect(result.usage?.totalTokens).toBe(17);
});

test("reports a missing OpenAI API key before making a request", async () => {
  const provider = new OpenAIResponsesProvider({
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
  });

  await expect(
    provider.generate({
      memberId: "gpt_chief",
      model: "gpt-5.6",
      messages: [{ role: "user", content: "plan" }],
    }),
  ).rejects.toThrow("Missing API key for provider: openai");
});
