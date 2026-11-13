import { ProjectRadarConflictError, ProjectRadarInputError, type ProjectRadarService } from "../application/project-radar-service";
import { HttpError, json, readJson } from "./http-boundary";
import { inputObject, optionalNumber, optionalStringArray } from "./input-schema";
import { parseProjectRadarActionId, ProjectRadarActionConflictError, ProjectRadarActionInputError,
  ProjectRadarActionNotFoundError } from "../domains/intelligence/project-radar-action";

export async function handleProjectRadarRoutes(request: Request, url: URL, dependencies: {
  service: Pick<ProjectRadarService, "status" | "saveSettings" | "evaluate" | "previewDigest" | "actions">;
  requireOperator(request: Request): void;
}): Promise<Response | undefined> {
  const root = "/api/intelligence/radar";
  if (url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return undefined;
  dependencies.requireOperator(request);
  try {
    if (request.method === "GET" && url.pathname === root) return privateJson(await dependencies.service.status());
    if (request.method === "PUT" && url.pathname === `${root}/settings`) {
      return privateJson(dependencies.service.saveSettings(await readJson(request, 32_000)));
    }
    if (request.method === "POST" && url.pathname === `${root}/evaluate`) {
      const body = inputObject(await readJson(request, 4_000));
      if (Object.keys(body).some((key) => !["limit", "candidate_ids"].includes(key))) throw new HttpError(400, "Unknown evaluation field");
      const limit = optionalNumber(body.limit, "limit", { minimum: 1, maximum: 10, integer: true }) ?? 10;
      const ids = optionalStringArray(body.candidate_ids, "candidate_ids", 10, 100);
      if (ids && (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id)))) {
        throw new HttpError(400, "candidate_ids must contain unique candidate IDs");
      }
      return privateJson(await dependencies.service.evaluate({ limit, ...(ids ? { candidate_ids: ids } : {}) }));
    }
    if (request.method === "GET" && url.pathname === `${root}/digest`) return privateJson(await dependencies.service.previewDigest());
    if (request.method === "GET" && url.pathname === `${root}/actions`) return privateJson({ actions: dependencies.service.actions.list(100) });
    const action = url.pathname.match(/^\/api\/intelligence\/radar\/actions\/([^/]+)\/(decision|handoff)$/);
    if (action) {
      const id = parseProjectRadarActionId(action[1]);
      if (request.method === "GET" && action[2] === "handoff") return privateJson(dependencies.service.actions.handoff(id));
      if (request.method === "POST" && action[2] === "decision") {
        const body = inputObject(await readJson(request, 4_000));
        if (Object.keys(body).some((key) => !["decision", "idempotency_key"].includes(key))) throw new HttpError(400, "Unknown action decision field");
        return privateJson(dependencies.service.actions.decide(id, { ...body, source: "web" }));
      }
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof ProjectRadarConflictError) throw new HttpError(409, error.message);
    if (error instanceof ProjectRadarInputError) throw new HttpError(400, error.message);
    if (error instanceof ProjectRadarActionInputError) throw new HttpError(400, error.message);
    if (error instanceof ProjectRadarActionConflictError) throw new HttpError(409, error.message);
    if (error instanceof ProjectRadarActionNotFoundError) throw new HttpError(404, error.message);
    throw error;
  }
}

function privateJson(value: unknown): Response {
  const response = json(value);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
