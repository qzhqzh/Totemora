import { DEAL_STATUS_VALUES, type DealStatus } from "../domains/deals/deal";
import type { DealSummary } from "../repositories/deal-repository";
import { HttpError, json } from "./http-boundary";

export interface DealsRouteService {
  list(status: DealStatus | "all", limit: number): unknown[];
  status(): DealSummary;
}
export interface DealsRouteDependencies {
  service: DealsRouteService;
  requireOperator(request: Request): void;
}

export async function handleDealsRoutes(
  request: Request,
  url: URL,
  dependencies: DealsRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/deals")) return undefined;
  dependencies.requireOperator(request);
  if (request.method === "GET" && url.pathname === "/api/deals/status") {
    return json(dependencies.service.status());
  }
  if (request.method === "GET" && url.pathname === "/api/deals") {
    const status = dealStatus(url.searchParams.get("status"));
    const limit = readLimit(url.searchParams.get("limit"));
    return json({ status, deals: dependencies.service.list(status, limit) });
  }
  return undefined;
}

function dealStatus(value: string | null): DealStatus | "all" {
  const status = value?.trim() || "all";
  if (status !== "all" && !DEAL_STATUS_VALUES.includes(status as DealStatus)) {
    throw new HttpError(400, `status must be all or ${DEAL_STATUS_VALUES.join(", ")}`);
  }
  return status as DealStatus | "all";
}

function readLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^\d+$/.test(value)) throw new HttpError(400, "limit must be a positive integer");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "limit must be 1-100");
  return limit;
}
