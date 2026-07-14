import type {
  AgentProvider,
  ModelRequest,
  ModelResponse,
} from "@totemora/core";

import { combineSignal, type FetchLike } from "./openai-compatible";

export interface AnthropicCompatibleProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
}

interface MessagesPayload {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

export class AnthropicCompatibleProvider implements AgentProvider {
  constructor(
    private readonly options: AnthropicCompatibleProviderOptions,
    private readonly request: FetchLike = fetch,
  ) {}

  async generate(input: ModelRequest): Promise<ModelResponse> {
    if (!this.options.apiKey) {
      throw new Error(`Missing API key for provider: ${this.options.id}`);
    }

    const system = input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = input.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content }));
    const response = await this.request(
      `${this.options.baseUrl.replace(/\/$/, "")}/v1/messages`,
      {
        method: "POST",
        signal: combineSignal(input.signal),
        headers: {
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          system: system || undefined,
          messages,
          max_tokens: input.maxTokens ?? 1024,
          stream: false,
        }),
      },
    );

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Provider ${this.options.id} request failed (${response.status}): ${summarizeError(rawText)}`,
      );
    }

    let payload: MessagesPayload;
    try {
      payload = JSON.parse(rawText) as MessagesPayload;
    } catch {
      throw new Error(`Provider ${this.options.id} returned invalid JSON`);
    }
    const content = payload.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    if (!content) {
      const blockTypes = payload.content?.map((block) => block.type ?? "unknown") ?? [];
      throw new Error(
        `Provider ${this.options.id} returned no text content` +
          ` (stop_reason=${payload.stop_reason ?? "unknown"}, blocks=${blockTypes.join(",") || "none"}, output_tokens=${payload.usage?.output_tokens ?? "unknown"})`,
      );
    }
    const inputTokens = payload.usage?.input_tokens;
    const outputTokens = payload.usage?.output_tokens;
    return {
      content,
      usage: payload.usage
        ? {
            inputTokens,
            outputTokens,
            totalTokens:
              inputTokens !== undefined && outputTokens !== undefined
                ? inputTokens + outputTokens
                : undefined,
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
