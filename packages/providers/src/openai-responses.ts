import type {
  AgentProvider,
  ModelRequest,
  ModelResponse,
} from "@totemora/core";

import { combineSignal, type FetchLike } from "./openai-compatible";

export interface OpenAIResponsesProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
}

interface ResponsesPayload {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAIResponsesProvider implements AgentProvider {
  constructor(
    private readonly options: OpenAIResponsesProviderOptions,
    private readonly request: FetchLike = fetch,
  ) {}

  async generate(input: ModelRequest): Promise<ModelResponse> {
    if (!this.options.apiKey) {
      throw new Error(`Missing API key for provider: ${this.options.id}`);
    }

    const response = await this.request(
      `${this.options.baseUrl.replace(/\/$/, "")}/responses`,
      {
        method: "POST",
        signal: combineSignal(input.signal),
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          input: input.messages,
          store: false,
          max_output_tokens: input.maxTokens,
          ...(input.responseFormat === "json"
            ? { text: { format: { type: "json_object" } } }
            : {}),
        }),
      },
    );

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Provider ${this.options.id} request failed (${response.status}): ${summarizeError(rawText)}`,
      );
    }

    let payload: ResponsesPayload;
    try {
      payload = JSON.parse(rawText) as ResponsesPayload;
    } catch {
      throw new Error(`Provider ${this.options.id} returned invalid JSON`);
    }

    const content = payload.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text ?? "")
      .join("");
    if (!content) {
      throw new Error(`Provider ${this.options.id} returned no output text`);
    }

    return {
      content,
      usage: payload.usage
        ? {
            inputTokens: payload.usage.input_tokens,
            outputTokens: payload.usage.output_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
      raw: payload,
    };
  }
}

function summarizeError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 500) || "empty response";
}
