import type { DecisionAnswer, DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResponse } from "@totemora/core";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAXIMUM_BYTES = 256 * 1024;
const PROBABILITY_TOLERANCE = 0.001;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export interface JevDecisionProviderOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type JevDecisionErrorCode = "invalid_request" | "authentication" | "rate_limit" | "unavailable"
  | "http_error" | "network" | "timeout" | "aborted" | "invalid_response" | "response_too_large";

/** Messages deliberately omit upstream bodies, headers, and exception details. */
export class JevDecisionError extends Error {
  constructor(readonly code: JevDecisionErrorCode, readonly status?: number) {
    super(`Jev decision request failed: ${code}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "JevDecisionError";
  }
}

export class JevDecisionProvider implements DecisionProvider {
  constructor(private readonly options: JevDecisionProviderOptions) {}

  async evaluate(input: DecisionRequest): Promise<DecisionResponse> {
    const { apiKey, fetchImpl = fetch, timeoutMs = 30_000 } = this.options;
    if (typeof apiKey !== "string" || !apiKey.trim() || /[\s\x00-\x1f\x7f]/.test(apiKey)) {
      throw new JevDecisionError("authentication");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new JevDecisionError("invalid_request");
    }
    const { body, questions } = prepareRequest(input, this.options.model ?? "jev-latest");
    if (input.signal?.aborted) throw new JevDecisionError("aborted");
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let rejectAborted: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(new JevDecisionError(timedOut ? "timeout" : "aborted"));
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    try {
      const operation = async () => {
        const response = await fetchImpl(ENDPOINT, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new JevDecisionError(httpErrorCode(response.status), response.status);
        }
        const text = await readResponse(response, controller.signal);
        let payload: unknown;
        try { payload = JSON.parse(text); } catch { throw new JevDecisionError("invalid_response"); }
        return parseResponse(payload, questions);
      };
      return await Promise.race([operation(), aborted]);
    } catch (error) {
      if (controller.signal.aborted) throw new JevDecisionError(timedOut ? "timeout" : "aborted");
      if (error instanceof JevDecisionError) throw error;
      throw new JevDecisionError("network");
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAborted);
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown, maximum = 8_192): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function sameKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function prepareRequest(input: DecisionRequest, defaultModel: string): { body: string; questions: Record<string, DecisionQuestion> } {
  const fail = () => { throw new JevDecisionError("invalid_request"); };
  if (!record(input)) return fail();
  let body: string;
  try {
    body = JSON.stringify({ state: input.state, model: input.model ?? defaultModel, questions: input.questions }, (_key, value) => {
      if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol"
        || (typeof value === "number" && !Number.isFinite(value))) fail();
      return value;
    });
  } catch { return fail(); }
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_BYTES) return fail();
  // Snapshot the exact wire request, so callers cannot change validation during an await.
  const request = JSON.parse(body) as Record<string, unknown>;
  if (!(typeof request.state === "string" || record(request.state) || Array.isArray(request.state))
    || typeof request.model !== "string" || !MODEL_PATTERN.test(request.model) || !record(request.questions)) return fail();
  const entries = Object.entries(request.questions);
  if (!entries.length || entries.length > 128) return fail();
  for (const [id, question] of entries) {
    if (!validText(id, 128) || /\s/.test(id) || !record(question) || !validText(question.instructions)) return fail();
    const { type, criteria } = question;
    if (type === "choice") {
      if (!record(criteria)) return fail();
      const options = Object.entries(criteria);
      if (!options.length || options.length > 255 || options.some(([key, value]) => !validText(key, 128)
        || (value !== null && !validText(value)))) return fail();
    } else if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || criteria.some((value) => !validText(value))) return fail();
    } else if (type === "noul") {
      if (criteria !== undefined && (!record(criteria) || Object.entries(criteria).some(([key, value]) =>
        !["true", "false"].includes(key) || !validText(value)))) return fail();
    } else return fail();
  }
  return { body, questions: request.questions as Record<string, DecisionQuestion> };
}

function httpErrorCode(status: number): JevDecisionErrorCode {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status >= 500 || status === 408) return "unavailable";
  if (status === 400 || status === 413 || status === 422) return "invalid_request";
  return "http_error";
}

async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAXIMUM_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new JevDecisionError("response_too_large");
  }
  if (!response.body) throw new JevDecisionError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (signal.aborted) { cancel(); throw new JevDecisionError("aborted"); }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMUM_BYTES) { cancel(); throw new JevDecisionError("response_too_large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new JevDecisionError("invalid_response"); }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function numberInRange(value: unknown, maximum = 1): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function probabilities(value: unknown, keys: string[]): Record<string, number> {
  if (!record(value) || !sameKeys(value, keys) || !Object.values(value).every((item) => numberInRange(item))) {
    throw new JevDecisionError("invalid_response");
  }
  const result = value as Record<string, number>;
  if (Math.abs(Object.values(result).reduce((sum, item) => sum + item, 0) - 1) > PROBABILITY_TOLERANCE) {
    throw new JevDecisionError("invalid_response");
  }
  return result;
}

function parseAnswer(value: unknown, question: DecisionQuestion): DecisionAnswer {
  const fail = (): never => { throw new JevDecisionError("invalid_response"); };
  if (!record(value) || value.type !== question.type) return fail();
  if (question.type === "noul") return numberInRange(value.noul) ? { type: "noul", noul: value.noul } : fail();
  if (!numberInRange(value.confidence)) return fail();
  if (question.type === "choice") {
    const distribution = probabilities(value.probabilities, Object.keys(question.criteria));
    if (typeof value.choice !== "string" || !Object.hasOwn(distribution, value.choice)
      || distribution[value.choice] + PROBABILITY_TOLERANCE < Math.max(...Object.values(distribution))) return fail();
    return { type: "choice", choice: value.choice, probabilities: distribution, confidence: value.confidence };
  }
  const keys = question.criteria.map((_, index) => String(index));
  const distribution = probabilities(value.probabilities, keys);
  const legend = value.legend;
  if (!record(legend) || !sameKeys(legend, keys) || keys.some((key) => legend[key] !== question.criteria[Number(key)])
    || !numberInRange(value.score, keys.length - 1)) return fail();
  const expected = keys.reduce((sum, key) => sum + Number(key) * distribution[key], 0);
  if (Math.abs(value.score - expected) > PROBABILITY_TOLERANCE * keys.length) return fail();
  return { type: "score", score: value.score, legend: legend as Record<string, string>, probabilities: distribution, confidence: value.confidence };
}

function parseResponse(payload: unknown, questions: Record<string, DecisionQuestion>): DecisionResponse {
  if (!record(payload) || typeof payload.model !== "string" || !MODEL_PATTERN.test(payload.model)
    || !record(payload.answers) || !sameKeys(payload.answers, Object.keys(questions))) throw new JevDecisionError("invalid_response");
  const wireAnswers = payload.answers;
  const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, parseAnswer(wireAnswers[key], question)]));
  let usage: DecisionResponse["usage"];
  if (payload.usage !== undefined) {
    if (!record(payload.usage)) throw new JevDecisionError("invalid_response");
    for (const key of ["input_tokens", "output_tokens"]) {
      const value = payload.usage[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) throw new JevDecisionError("invalid_response");
    }
    usage = { inputTokens: payload.usage.input_tokens as number | undefined, outputTokens: payload.usage.output_tokens as number | undefined };
  }
  return { model: payload.model, answers, ...(usage ? { usage } : {}) };
}
