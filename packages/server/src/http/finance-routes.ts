import type { FinanceIntelligenceService } from "../finance-intelligence-service";
import type { FinancePreferenceStore } from "../finance-preference-store";
import { HttpError, json, readJson, readOptionalJson } from "./http-boundary";
import {
  financePreferencesInput,
  financeTaskInput,
  manualFinanceRunInput,
  type IntelligenceTaskRouteInput,
} from "./intelligence-input-schema";
import type { IntelligenceTaskView } from "./intelligence-routes";

export type FinanceRouteService = Pick<FinanceIntelligenceService,
  "list" | "listCandidates" | "candidateCounts" | "sourceStatus" | "barkStatus" | "run"
>;

export interface FinanceRouteDependencies {
  getFinance(): Promise<FinanceRouteService>;
  preferences: Pick<FinancePreferenceStore, "get" | "save">;
  enqueueTask(input: IntelligenceTaskRouteInput & { domain: "finance" }): Promise<unknown>;
  getTask(id: string): IntelligenceTaskView | undefined;
  requireOperator(request: Request): void;
}

export async function handleFinanceRoutes(
  request: Request,
  url: URL,
  dependencies: FinanceRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/finance")) return undefined;

  if (request.method === "GET" && url.pathname === "/api/finance") {
    return json({ briefs: await (await dependencies.getFinance()).list() });
  }
  if (request.method === "GET" && url.pathname === "/api/finance/candidates") {
    const finance = await dependencies.getFinance();
    const [candidates, counts] = await Promise.all([
      finance.listCandidates(), finance.candidateCounts(),
    ]);
    return json({ candidates, counts });
  }
  if (request.method === "GET" && url.pathname === "/api/finance/sources") {
    return json({ sources: await (await dependencies.getFinance()).sourceStatus() });
  }
  if (request.method === "GET" && url.pathname === "/api/finance/bark") {
    dependencies.requireOperator(request);
    return json(await (await dependencies.getFinance()).barkStatus(healthCheck(url)));
  }
  if (request.method === "GET" && url.pathname === "/api/finance/preferences") {
    return json(await dependencies.preferences.get());
  }
  if (request.method === "PUT" && url.pathname === "/api/finance/preferences") {
    dependencies.requireOperator(request);
    return json(await dependencies.preferences.save(
      financePreferencesInput(await readJson(request, 32_000)),
    ));
  }
  if (request.method === "POST" && url.pathname === "/api/finance/run") {
    dependencies.requireOperator(request);
    const input = manualFinanceRunInput(await readOptionalJson(request, 8_000));
    return json(await (await dependencies.getFinance()).run({ ...input, reason: "manual" }), 201);
  }
  if (request.method === "POST" && url.pathname === "/api/finance/tasks") {
    dependencies.requireOperator(request);
    const input = financeTaskInput(await readOptionalJson(request, 8_000));
    return json(await dependencies.enqueueTask({ ...input, domain: "finance" }), 202);
  }

  const taskMatch = url.pathname.match(/^\/api\/finance\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    dependencies.requireOperator(request);
    const task = dependencies.getTask(decodePathSegment(taskMatch[1]!));
    return task?.domain === "finance" ? json(task) : json({ error: "Finance task not found" }, 404);
  }
  return undefined;
}

function healthCheck(url: URL): boolean {
  const value = url.searchParams.get("health");
  if (value === null || value === "0") return false;
  if (value === "1") return true;
  throw new HttpError(400, "health must be 0 or 1");
}

function decodePathSegment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, "task id is not valid URL encoding"); }
}
