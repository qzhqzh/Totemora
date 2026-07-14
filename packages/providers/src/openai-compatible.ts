import type {
  AgentProvider,
  ModelRequest,
  ModelResponse,
} from "@totemora/core";

export interface OpenAICompatibleProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAICompatibleProvider implements AgentProvider {
  constructor(
    private readonly options: OpenAICompatibleProviderOptions,
    private readonly request: FetchLike = fetch,
  ) {}

  async generate(input: ModelRequest): Promise<ModelResponse> {
    if (!this.options.apiKey) {
      throw new Error(`Missing API key for provider: ${this.options.id}`);
    }

    const response = await this.request(
      `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        signal: combineSignal(input.signal),
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          stream: false,
          max_tokens: input.maxTokens,
          ...(input.responseFormat === "json"
            ? { response_format: { type: "json_object" } }
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

    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(rawText) as ChatCompletionResponse;
    } catch {
      throw new Error(`Provider ${this.options.id} returned invalid JSON`);
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`Provider ${this.options.id} returned no message content`);
    }

    return {
      content,
      usage: payload.usage
        ? {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
      raw: payload,
    };
  }
}

export function combineSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(120_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function summarizeError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 500) || "empty response";
}
