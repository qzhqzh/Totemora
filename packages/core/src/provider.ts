export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  memberId: string;
  model: string;
  messages: ModelMessage[];
  responseFormat?: "text" | "json";
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelResponse {
  content: string;
  usage?: ModelUsage;
  raw?: unknown;
}

export interface AgentProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface ProviderRegistry {
  get(providerId: string): AgentProvider;
}
