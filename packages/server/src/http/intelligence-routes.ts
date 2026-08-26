import type { IntelligencePreferenceStore } from "../intelligence-preference-store";
import type { IntelligenceService } from "../intelligence-service";
import { HttpError, json, readJson, readOptionalJson } from "./http-boundary";
import {
  intelligencePreferencesInput,
  intelligenceTaskInput,
  manualIntelligenceRunInput,
  telegramUpdateInput,
  type IntelligenceTaskRouteInput,
} from "./intelligence-input-schema";
import { inputObject, optionalEnum } from "./input-schema";

const FEEDBACK_SIGNALS = ["valuable", "not_valuable", "duplicate", "too_late"] as const;

export type IntelligenceRouteService = Pick<IntelligenceService,
  "list" | "listCandidates" | "candidateCounts" | "barkStatus" | "telegramStatus"
  | "verifyTelegramWebhook" | "handleTelegramUpdate" | "recordFeedback" | "openFeedback" | "run"
>;

export interface IntelligenceTaskView {
  domain: "ai" | "finance";
}

export interface IntelligenceRouteDependencies {
  getIntelligence(): Promise<IntelligenceRouteService>;
  preferences: Pick<IntelligencePreferenceStore, "get" | "save">;
  credentialStatus(): Promise<{ x_trends: boolean; weibo_hot: boolean }>;
  enqueueTask(input: IntelligenceTaskRouteInput & { domain: "ai" }): Promise<unknown>;
  getTask(id: string): IntelligenceTaskView | undefined;
  requireOperator(request: Request): void;
}

export async function handleIntelligenceRoutes(
  request: Request,
  url: URL,
  dependencies: IntelligenceRouteDependencies,
): Promise<Response | undefined> {
  if (!isIntelligencePath(url.pathname)) return undefined;

  if (request.method === "GET" && url.pathname === "/api/intelligence") {
    return json({ briefs: await (await dependencies.getIntelligence()).list() });
  }
  if (request.method === "GET" && url.pathname === "/api/intelligence/candidates") {
    const intelligence = await dependencies.getIntelligence();
    const [candidates, counts] = await Promise.all([
      intelligence.listCandidates(), intelligence.candidateCounts(),
    ]);
    return json({ candidates, counts });
  }
  if (request.method === "GET" && url.pathname === "/api/intelligence/bark") {
    dependencies.requireOperator(request);
    return json(await (await dependencies.getIntelligence()).barkStatus(healthCheck(url)));
  }
  if (request.method === "GET" && url.pathname === "/api/intelligence/telegram") {
    dependencies.requireOperator(request);
    return json(await (await dependencies.getIntelligence()).telegramStatus(healthCheck(url)));
  }
  if (request.method === "POST" && url.pathname === "/api/integrations/telegram/webhook") {
    const intelligence = await dependencies.getIntelligence();
    try {
      await intelligence.verifyTelegramWebhook(request.headers.get("x-telegram-bot-api-secret-token"));
    } catch {
      throw new HttpError(401, "Telegram webhook authorization failed");
    }
    return json(await intelligence.handleTelegramUpdate(telegramUpdateInput(await readJson(request, 128_000))));
  }

  const candidateFeedback = url.pathname.match(/^\/api\/intelligence\/candidates\/([^/]+)\/feedback$/);
  if (request.method === "POST" && candidateFeedback) {
    dependencies.requireOperator(request);
    const input = inputObject(await readJson(request, 8_000));
    const signal = optionalEnum(input.signal, "signal", FEEDBACK_SIGNALS);
    if (!signal) throw new HttpError(400, `signal must be one of ${FEEDBACK_SIGNALS.join(", ")}`);
    const candidateId = decodePathSegment(candidateFeedback[1]!, "candidate id");
    return json(await translate(() => dependencies.getIntelligence()
      .then((intelligence) => intelligence.recordFeedback(candidateId, signal))));
  }

  const feedbackRedirect = url.pathname.match(/^\/r\/([^/]+)$/);
  if (request.method === "GET" && feedbackRedirect) {
    const token = decodePathSegment(feedbackRedirect[1]!, "feedback token");
    const result = await (await dependencies.getIntelligence()).openFeedback(token);
    if (!result) return json({ error: "Feedback link not found" }, 404);
    return new Response(null, {
      status: 303,
      headers: { location: result.target_url, "cache-control": "no-store" },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/intelligence/preferences") {
    return json({ ...await dependencies.preferences.get(), credentials: await dependencies.credentialStatus() });
  }
  if (request.method === "PUT" && url.pathname === "/api/intelligence/preferences") {
    dependencies.requireOperator(request);
    return json(await dependencies.preferences.save(
      intelligencePreferencesInput(await readJson(request, 16_000)),
    ));
  }
  if (request.method === "POST" && url.pathname === "/api/intelligence/run") {
    dependencies.requireOperator(request);
    const input = manualIntelligenceRunInput(await readOptionalJson(request, 8_000));
    return json(await (await dependencies.getIntelligence()).run({ ...input, reason: "manual" }), 201);
  }
  if (request.method === "POST" && url.pathname === "/api/intelligence/tasks") {
    dependencies.requireOperator(request);
    const input = intelligenceTaskInput(await readOptionalJson(request, 8_000));
    return json(await dependencies.enqueueTask({ ...input, domain: "ai" }), 202);
  }

  const taskMatch = url.pathname.match(/^\/api\/intelligence\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    dependencies.requireOperator(request);
    const task = dependencies.getTask(decodePathSegment(taskMatch[1]!, "task id"));
    return task?.domain === "ai" ? json(task) : json({ error: "Intelligence task not found" }, 404);
  }
  return undefined;
}

function isIntelligencePath(pathname: string): boolean {
  return pathname === "/api/integrations/telegram/webhook"
    || pathname.startsWith("/api/intelligence") || pathname.startsWith("/r/");
}

function healthCheck(url: URL): boolean {
  const value = url.searchParams.get("health");
  if (value === null || value === "0") return false;
  if (value === "1") return true;
  throw new HttpError(400, "health must be 0 or 1");
}

function decodePathSegment(value: string, label: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, `${label} is not valid URL encoding`); }
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.startsWith("Intelligence candidate not found:")) throw new HttpError(404, detail);
    throw error;
  }
}
