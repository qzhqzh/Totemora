import type { CodexScheduledDeliveryService } from "../application/codex-scheduled-delivery-service";
import {
  CodexScheduledDeliveryConfigurationError,
  CodexScheduledSubscriptionLimitError,
} from "../application/codex-scheduled-delivery-service";
import { HttpError, json, readJson } from "./http-boundary";
import { inputObject, optionalNumber, requiredString } from "./input-schema";

export type CodexScheduledRouteService = Pick<CodexScheduledDeliveryService,
  "overview" | "createSubscription" | "revokeSubscription"
>;

export interface CodexScheduledRouteDependencies {
  service: CodexScheduledRouteService;
  requireOperator(request: Request): void;
}

export async function handleCodexScheduledRoutes(
  request: Request,
  url: URL,
  dependencies: CodexScheduledRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/codex/scheduled-subscriptions")) return undefined;
  dependencies.requireOperator(request);
  try {
    if (request.method === "GET" && url.pathname === "/api/codex/scheduled-subscriptions") {
      return json(await dependencies.service.overview());
    }
    if (request.method === "POST" && url.pathname === "/api/codex/scheduled-subscriptions") {
      const body = inputObject(await readJson(request, 4_000));
      const result = await dependencies.service.createSubscription({
        name: requiredString(body.name, "name", 120),
        target_chat_id: requiredString(body.target_chat_id, "target_chat_id", 32),
      });
      return json(result, 201);
    }
    const revokeMatch = url.pathname.match(/^\/api\/codex\/scheduled-subscriptions\/([^/]+)$/);
    if (request.method === "DELETE" && revokeMatch) {
      const body = inputObject(await readJson(request, 4_000));
      const revision = optionalNumber(body.expected_revision, "expected_revision", { minimum: 1, integer: true });
      if (revision === undefined) throw new HttpError(400, "expected_revision is required");
      return json({ subscription: dependencies.service.revokeSubscription(
        decodeSegment(revokeMatch[1]!),
        revision,
      ) });
    }
    return undefined;
  } catch (error) {
    throw translate(error);
  }
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, "subscription id is not valid URL encoding"); }
}

function translate(error: unknown): Error {
  if (error instanceof HttpError) return error;
  if (error instanceof CodexScheduledSubscriptionLimitError) return new HttpError(409, error.message);
  if (error instanceof CodexScheduledDeliveryConfigurationError) return new HttpError(422, error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("revision conflict")) return new HttpError(409, message);
  if (message.toLowerCase().includes("not found")) return new HttpError(404, message);
  return error instanceof Error ? error : new Error(message);
}
