import { expect, test } from "bun:test";
import type { DecisionRequest } from "@totemora/core";
import { JevDecisionError, JevDecisionProvider } from "./jev-decision-provider";

const apiKey = "test-private-key";
const request = (): DecisionRequest => ({
  state: { title: "A new release", evidence: ["Official release notes"] },
  questions: {
    project: { type: "choice", instructions: "Which project is relevant?", criteria: { totemora: "Agent tooling", other: null } },
    impact: { type: "score", instructions: "Rate the impact.", criteria: ["None", "Useful", "Significant"] },
    novel: { type: "noul", instructions: "Does this add a new fact?", criteria: { true: "New fact", false: "Already known" } },
  },
});

function payload(): { model: unknown; answers: Record<string, Record<string, unknown>>; usage?: unknown } {
  return {
    model: "jev-1.13.0",
    answers: {
      project: { type: "choice", choice: "totemora", probabilities: { totemora: 0.8, other: 0.2 }, confidence: 0.7 },
      impact: { type: "score", score: 1.25, probabilities: { "0": 0, "1": 0.75, "2": 0.25 }, legend: { "0": "None", "1": "Useful", "2": "Significant" }, confidence: 0.6 },
      novel: { type: "noul", noul: 0.9 },
    },
    usage: { input_tokens: 120, output_tokens: 22 },
  };
}

function fakeFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return handler as typeof fetch;
}

function providerWithResponse(value: unknown): JevDecisionProvider {
  return new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async () => Response.json(value)) });
}

test("sends all primitive questions together and preserves fractional scores and confidence", async () => {
  let received: { url: string; init?: RequestInit } | undefined;
  const provider = new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async (input, init) => {
    received = { url: String(input), init };
    return Response.json(payload());
  }) });
  const input = request();
  const result = await provider.evaluate(input);
  expect(received?.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(received?.init?.method).toBe("POST");
  expect(received?.init?.redirect).toBe("error");
  expect(new Headers(received?.init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
  expect(JSON.parse(String(received?.init?.body))).toEqual({ state: input.state, model: "jev-latest", questions: input.questions });
  expect<unknown>(result).toEqual({ ...payload(), usage: { inputTokens: 120, outputTokens: 22 } });
});

test("honors explicit model and leaves absent usage absent", async () => {
  const response = payload();
  delete response.usage;
  const provider = new JevDecisionProvider({ apiKey, model: "jev-default", fetchImpl: fakeFetch(async (_input, init) => {
    expect(JSON.parse(String(init?.body)).model).toBe("jev-pinned");
    return Response.json(response);
  }) });
  expect((await provider.evaluate({ ...request(), model: "jev-pinned" })).usage).toBeUndefined();
});

test("validates against the sent snapshot if caller mutates questions during fetch", async () => {
  const input = request();
  const provider = new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async () => {
    input.questions.impact = { type: "score", instructions: "Changed", criteria: ["Low", "High"] };
    return Response.json(payload());
  }) });
  expect((await provider.evaluate(input)).answers.impact).toMatchObject({ score: 1.25 });
});

test.each([
  ["choice outside rubric", "project", "choice", "unknown"],
  ["choice not highest probability", "project", "choice", "other"],
  ["missing confidence", "project", "confidence", undefined],
  ["confidence over one", "project", "confidence", 1.1],
  ["negative confidence", "impact", "confidence", -0.1],
  ["missing probability option", "project", "probabilities", { totemora: 1 }],
  ["extra probability option", "project", "probabilities", { totemora: 0.8, other: 0.2, unknown: 0 }],
  ["negative probability", "project", "probabilities", { totemora: 1.1, other: -0.1 }],
  ["invalid probability total", "project", "probabilities", { totemora: 0.7, other: 0.1 }],
  ["string probability", "project", "probabilities", { totemora: "0.8", other: 0.2 }],
  ["missing score", "impact", "score", undefined],
  ["out of rubric score", "impact", "score", 3],
  ["score not weighted mean", "impact", "score", 1.7],
  ["missing legend", "impact", "legend", undefined],
  ["different legend", "impact", "legend", { "0": "None", "1": "Changed", "2": "Significant" }],
  ["missing legend level", "impact", "legend", { "0": "None", "1": "Useful" }],
  ["missing score probability", "impact", "probabilities", { "0": 0, "1": 1 }],
  ["wrong answer type", "novel", "type", "score"],
  ["missing noul", "novel", "noul", undefined],
  ["negative noul", "novel", "noul", -0.1],
  ["noul above one", "novel", "noul", 1.1],
  ["string noul", "novel", "noul", "0.9"],
] as const)("rejects %s without filling defaults", async (_label, answer, key, value) => {
  const response = payload();
  response.answers[answer][key] = value;
  await expect(providerWithResponse(response).evaluate(request())).rejects.toMatchObject({ code: "invalid_response" });
});

test("requires answers to match question IDs exactly", async () => {
  const missing = payload();
  delete missing.answers.novel;
  await expect(providerWithResponse(missing).evaluate(request())).rejects.toMatchObject({ code: "invalid_response" });
  const extra = payload();
  extra.answers.unrequested = { type: "noul", noul: 1 };
  await expect(providerWithResponse(extra).evaluate(request())).rejects.toMatchObject({ code: "invalid_response" });
});

test.each([null, {}, { answers: {} }, { model: "jev-latest", answers: [] }])("rejects invalid response envelope %j", async (value) => {
  await expect(providerWithResponse(value).evaluate(request())).rejects.toMatchObject({ code: "invalid_response" });
});

test.each([{ input_tokens: -1 }, { output_tokens: 1.5 }, null, { input_tokens: "12" }])("rejects invalid usage %j", async (usage) => {
  await expect(providerWithResponse({ ...payload(), usage }).evaluate(request())).rejects.toMatchObject({ code: "invalid_response" });
});

test("bounds JSON input and rejects malformed rubrics without calling fetch", async () => {
  let calls = 0;
  const provider = new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async () => { calls++; return Response.json(payload()); }) });
  const invalid: unknown[] = [
    { ...request(), state: "大".repeat(90_000) }, { ...request(), state: null },
    { ...request(), state: { count: Infinity } }, { ...request(), state: undefined },
    { ...request(), model: "bad\nmodel" }, { ...request(), questions: {} },
    { ...request(), questions: { x: { type: "score", instructions: "Rate", criteria: ["Only"] } } },
    { ...request(), questions: { x: { type: "score", instructions: "Rate", criteria: Array(11).fill("Level") } } },
    { ...request(), questions: { x: { type: "choice", instructions: "Choose", criteria: {} } } },
    { ...request(), questions: { x: { type: "noul", instructions: "", criteria: {} } } },
    { ...request(), questions: { x: { type: "noul", instructions: "True?", criteria: { unknown: "yes" } } } },
    { ...request(), questions: { "bad\nid": { type: "noul", instructions: "True?" } } },
  ];
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  invalid.push({ ...request(), state: circular });
  for (const input of invalid) {
    await expect(provider.evaluate(input as DecisionRequest)).rejects.toMatchObject({ code: "invalid_request" });
  }
  expect(calls).toBe(0);
});

test.each([[401, "authentication"], [403, "authentication"], [422, "invalid_request"], [413, "invalid_request"],
  [429, "rate_limit"], [529, "unavailable"], [503, "unavailable"], [404, "http_error"]] as const)(
  "classifies HTTP %d without retries or sensitive response details", async (status, code) => {
    let calls = 0;
    const provider = new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async () => {
      calls++;
      return new Response(`Upstream echoed ${apiKey}`, { status });
    }) });
    const error = await provider.evaluate(request()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(JevDecisionError);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain(apiKey);
    expect(calls).toBe(1);
  },
);

test("sanitizes network errors and rejects invalid credentials locally", async () => {
  const provider = new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async () => { throw new Error(apiKey); }) });
  const error = await provider.evaluate(request()).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "network" });
  expect(String(error)).not.toContain(apiKey);
  for (const key of ["", "bad\nkey"]) {
    await expect(new JevDecisionProvider({ apiKey: key }).evaluate(request())).rejects.toMatchObject({ code: "authentication" });
  }
});

test("rejects invalid JSON and oversized declared response bodies", async () => {
  for (const [response, code] of [
    [new Response("not json"), "invalid_response"],
    [new Response(new Uint8Array([0xff])), "invalid_response"],
    [new Response("{}", { headers: { "content-length": "262145" } }), "response_too_large"],
  ] as const) {
    const provider = new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async () => response) });
    await expect(provider.evaluate(request())).rejects.toMatchObject({ code });
  }
});

test("cancels oversized streamed responses without content-length", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(32_768)); },
    cancel() { cancelled = true; },
  }));
  const provider = new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async () => response) });
  await expect(provider.evaluate(request())).rejects.toMatchObject({ code: "response_too_large" });
  expect(cancelled).toBe(true);
});

test("timeout covers fetch even when transport ignores its signal", async () => {
  const provider = new JevDecisionProvider({ apiKey, timeoutMs: 10, fetchImpl: fakeFetch(async () => new Promise(() => {})) });
  await expect(provider.evaluate(request())).rejects.toMatchObject({ code: "timeout" });
});

test("timeout covers response streaming and cancels its reader", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  const provider = new JevDecisionProvider({ apiKey, timeoutMs: 10, fetchImpl: fakeFetch(async () => response) });
  await expect(provider.evaluate(request())).rejects.toMatchObject({ code: "timeout" });
  expect(cancelled).toBe(true);
});

test("distinguishes caller cancellation from timeout and does not call fetch when already aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = new JevDecisionProvider({ apiKey, fetchImpl: fakeFetch(async () => {
    calls++;
    controller.abort(new Error(apiKey));
    return new Promise(() => {});
  }) });
  await expect(provider.evaluate({ ...request(), signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  await expect(provider.evaluate({ ...request(), signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  expect(calls).toBe(1);
});
