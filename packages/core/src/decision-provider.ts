/** Typed judgments are separate from generative AgentProvider conversations. */
export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  model?: string;
  signal?: AbortSignal;
}

export type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number };

export interface DecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface DecisionProvider {
  evaluate(request: DecisionRequest): Promise<DecisionResponse>;
}
