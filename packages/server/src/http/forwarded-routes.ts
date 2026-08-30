import { FORWARDED_STATUS_VALUES, type ForwardedStatus } from "../domains/forwarded/forwarded-event";
import type { ForwardedSummary } from "../repositories/forwarded-repository";
import { HttpError, json } from "./http-boundary";

export interface ForwardedRouteService {
  list(status: ForwardedStatus | "all", limit: number): unknown[];
  status(): Promise<ForwardedSummary & { configured: boolean }>;
}

export interface ForwardedRouteDependencies {
  service: ForwardedRouteService;
  requireOperator(request: Request): void;
}

export async function handleForwardedRoutes(
  request: Request,
  url: URL,
  dependencies: ForwardedRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/forwarded")) return undefined;
  dependencies.requireOperator(request);
  if (request.method === "GET" && url.pathname === "/api/forwarded/status") {
    return json(await dependencies.service.status());
  }
  if (request.method === "GET" && url.pathname === "/api/forwarded") {
    const status = forwardedStatus(url.searchParams.get("status"));
    const limit = readLimit(url.searchParams.get("limit"));
    return json({ status, events: dependencies.service.list(status, limit) });
  }
  return undefined;
}

function forwardedStatus(value: string | null): ForwardedStatus | "all" {
  const status = value?.trim() || "all";
  if (status !== "all" && !FORWARDED_STATUS_VALUES.includes(status as ForwardedStatus)) {
    throw new HttpError(400, `status must be all or ${FORWARDED_STATUS_VALUES.join(", ")}`);
  }
  return status as ForwardedStatus | "all";
}

function readLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^\d+$/.test(value)) throw new HttpError(400, "limit must be a positive integer");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "limit must be 1-100");
  }
  return limit;
}
