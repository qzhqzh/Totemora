import { HttpError, json, readJson } from "./http-boundary";
import { requiredString } from "./input-schema";
import {
  workplaceCreateInput,
  workplacePolicyInput,
  type WorkplacePolicyRouteInput,
} from "./workplace-input-schema";

export interface WorkplaceRouteDependencies {
  getSettlement(): Promise<unknown>;
  addWorkplace(name: string, path: string): Promise<unknown>;
  setWorkplacePolicy(id: string, input: WorkplacePolicyRouteInput): Promise<unknown>;
  requireOperator(request: Request): void;
}

export async function handleWorkplaceRoutes(
  request: Request,
  url: URL,
  dependencies: WorkplaceRouteDependencies,
): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/settlement") {
    return json(await dependencies.getSettlement());
  }

  if (request.method === "POST" && url.pathname === "/api/workplaces") {
    dependencies.requireOperator(request);
    const input = workplaceCreateInput(await readJson(request, 8_000));
    return json(await translate(() => dependencies.addWorkplace(input.name, input.path)), 201);
  }

  const policyMatch = url.pathname.match(/^\/api\/workplaces\/([^/]+)\/policy$/);
  if (request.method === "PUT" && policyMatch) {
    dependencies.requireOperator(request);
    const id = decodePathSegment(policyMatch[1]!);
    const input = workplacePolicyInput(await readJson(request, 64_000));
    return json(await translate(() => dependencies.setWorkplacePolicy(id, input)));
  }
  return undefined;
}

function decodePathSegment(value: string): string {
  try { return requiredString(decodeURIComponent(value), "workplace id", 256); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "workplace id is not valid URL encoding");
  }
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === "工作地不存在") throw new HttpError(404, detail);
    if (detail === "这个路径已经登记为工作地") throw new HttpError(409, detail);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(code ?? "")) {
      throw new HttpError(400, "工作地路径不存在或不可访问");
    }
    throw error;
  }
}
