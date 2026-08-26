import {
  BarkTargetMutationError,
  type BarkNotificationService,
} from "../bark-notification-service";
import { HttpError, json, readJson, readOptionalJson } from "./http-boundary";
import { barkTargetInput, barkTestInput } from "./notification-input-schema";
import { requiredString } from "./input-schema";

type BarkManagement = Pick<BarkNotificationService,
  "managementStatus" | "upsertManagedTarget" | "listManagementAudit"
>;

export interface NotificationRouteDependencies {
  management: BarkManagement;
  testTarget(targetId: string, idempotencyKey?: string): Promise<{ accepted: true; replayed: boolean }>;
  requireOperator(request: Request): void;
}

export async function handleNotificationRoutes(
  request: Request,
  url: URL,
  dependencies: NotificationRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/notifications/bark")) return undefined;
  dependencies.requireOperator(request);

  if (request.method === "GET" && url.pathname === "/api/notifications/bark/targets") {
    return json(await dependencies.management.managementStatus(readHealth(url)));
  }
  if (request.method === "POST" && url.pathname === "/api/notifications/bark/targets") {
    const input = barkTargetInput(await readJson(request, 16_000));
    return json(await translateMutation(() => dependencies.management.upsertManagedTarget(
      input, "create",
    )), 201);
  }
  if (request.method === "GET" && url.pathname === "/api/notifications/bark/audit") {
    return json({ events: await dependencies.management.listManagementAudit() });
  }

  const testMatch = url.pathname.match(/^\/api\/notifications\/bark\/targets\/([^/]+)\/test$/);
  if (request.method === "POST" && testMatch) {
    const targetId = decodeTargetId(testMatch[1]!);
    const input = barkTestInput(await readOptionalJson(request, 4_000));
    return json({ target_id: targetId, ...await dependencies.testTarget(targetId, input.idempotency_key) });
  }

  const targetMatch = url.pathname.match(/^\/api\/notifications\/bark\/targets\/([^/]+)$/);
  if (request.method === "PUT" && targetMatch) {
    const targetId = decodeTargetId(targetMatch[1]!);
    const input = barkTargetInput(await readJson(request, 16_000), targetId);
    return json(await translateMutation(() => dependencies.management.upsertManagedTarget(
      input, "update",
    )));
  }
  return undefined;
}

function readHealth(url: URL): boolean {
  const value = url.searchParams.get("health");
  if (value === null || value === "0") return false;
  if (value === "1") return true;
  throw new HttpError(400, "health must be 0 or 1");
}

function decodeTargetId(value: string): string {
  try {
    const id = requiredString(decodeURIComponent(value), "target id", 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
      throw new HttpError(400, "target id contains unsupported characters");
    }
    return id;
  }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "target id is not valid URL encoding");
  }
}

async function translateMutation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof BarkTargetMutationError) throw new HttpError(error.status, error.message);
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("TOTEMORA_BARK_TARGETS_JSON is configured")) throw new HttpError(409, detail);
    if (detail.includes("Bark server origin is not allowlisted")) throw new HttpError(400, detail);
    throw error;
  }
}
