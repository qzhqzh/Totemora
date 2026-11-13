import { ExternalNotificationAuthorizationError, type ExternalNotificationService } from "../application/external-notification-service";
import { ExternalNotificationInputError } from "../domains/notification/external-event";
import {
  EXTERNAL_EVENT_STATUSES, ExternalNotificationConflictError, type ExternalEventStatus,
} from "../repositories/external-notification-repository";
import { HttpError, json, readJson } from "./http-boundary";

export async function handleExternalNotificationRoutes(
  request: Request,
  url: URL,
  service: ExternalNotificationService,
  requireOperator: (request: Request) => void,
): Promise<Response | undefined> {
  if (url.pathname === "/api/integrations/notifications/events" && request.method === "POST") {
    const result = await service.accept(await readJson(request, 16_384), request.headers.get("authorization"))
      .catch(rethrowBoundaryError);
    return json({ schema_version: 1, ...result }, 202);
  }
  if (!url.pathname.startsWith("/api/notifications/events")) return undefined;
  requireOperator(request);
  if (url.pathname === "/api/notifications/events" && request.method === "GET") {
    const status = url.searchParams.get("status") ?? "all";
    if (status !== "all" && !EXTERNAL_EVENT_STATUSES.includes(status as ExternalEventStatus)) {
      throw new HttpError(400, "Invalid event status");
    }
    const rawLimit = url.searchParams.get("limit") ?? "50";
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
      throw new HttpError(400, "limit must be 1-100");
    }
    return json({ events: service.list(status as ExternalEventStatus | "all", Number(rawLimit)) });
  }
  const single = url.pathname.match(/^\/api\/notifications\/events\/([0-9a-f-]{36})$/);
  if (single && request.method === "GET") {
    const event = service.get(single[1]!);
    return event ? json({ event }) : json({ error: "Event not found" }, 404);
  }
  const match = url.pathname.match(/^\/api\/notifications\/events\/([0-9a-f-]{36})\/retry$/);
  if (match && request.method === "POST") {
    try { return json(service.retryFailed(match[1]!), 202); }
    catch (error) { return rethrowBoundaryError(error); }
  }
  return undefined;
}

function rethrowBoundaryError(error: unknown): never {
  if (error instanceof ExternalNotificationInputError) throw new HttpError(400, error.message);
  if (error instanceof ExternalNotificationAuthorizationError) throw new HttpError(401, error.message);
  if (error instanceof ExternalNotificationConflictError) throw new HttpError(409, error.message);
  throw error;
}
