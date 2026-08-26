import { HttpError, json } from "./http-boundary";
import { requiredString } from "./input-schema";

export interface OperationsRouteDependencies {
  recurringServiceStatus(): unknown[];
  listTasks(limit: number): unknown[];
  getTask(id: string): unknown | undefined;
  listActions(): Promise<unknown[]>;
  requireOperator(request: Request): void;
}

export async function handleOperationsRoutes(
  request: Request,
  url: URL,
  dependencies: OperationsRouteDependencies,
): Promise<Response | undefined> {
  if (!isOperationsPath(url.pathname)) return undefined;
  dependencies.requireOperator(request);

  if (request.method === "GET" && url.pathname === "/api/operator/session") {
    return json({ authenticated: true });
  }
  if (request.method === "GET" && url.pathname === "/api/operations/recurring-services") {
    return json({ services: dependencies.recurringServiceStatus() });
  }
  if (request.method === "GET" && url.pathname === "/api/service-tasks") {
    return json({ tasks: dependencies.listTasks(readLimit(url)) });
  }
  const taskMatch = url.pathname.match(/^\/api\/service-tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    const task = dependencies.getTask(decodeTaskId(taskMatch[1]!));
    return task ? json(task) : json({ error: "Specialist task not found" }, 404);
  }
  if (request.method === "GET" && url.pathname === "/api/actions") {
    return json({ actions: (await dependencies.listActions()).slice(-100).reverse() });
  }
  return undefined;
}

function isOperationsPath(pathname: string): boolean {
  return pathname === "/api/operator/session"
    || pathname.startsWith("/api/operations/")
    || pathname === "/api/service-tasks"
    || pathname.startsWith("/api/service-tasks/")
    || pathname === "/api/actions";
}

function readLimit(url: URL): number {
  const value = url.searchParams.get("limit");
  if (value === null) return 100;
  if (!/^\d+$/.test(value)) throw new HttpError(400, "limit must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, "limit must be a safe integer");
  return Math.max(1, Math.min(200, parsed));
}

function decodeTaskId(value: string): string {
  try { return requiredString(decodeURIComponent(value), "task id", 256); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "task id is not valid URL encoding");
  }
}
