import type { CodexSupervisorService } from "../application/codex-supervisor-service";
import {
  CodexSupervisorUnavailableError,
  CodexThreadUnmanageableError,
} from "../application/codex-supervisor-service";
import {
  CODEX_GOAL_OBJECTIVE_MAX_CHARS,
  type CodexInteraction,
} from "../domains/codex/codex-supervisor-types";
import { HttpError, json, readJson } from "./http-boundary";
import { inputObject, optionalEnum, optionalNumber, optionalString, requiredString } from "./input-schema";

const MODES = ["observed", "managed"] as const;
const PHASES = [
  "observed", "aligning", "executing", "waiting_decision", "waiting_approval",
  "retry_wait", "verifying", "paused", "completed", "failed",
] as const;
const INTERACTION_STATUSES = [
  "open", "answered", "defaulted", "expired", "resolved", "cancelled", "manual_attention",
] as const;

export type CodexRouteService = Pick<CodexSupervisorService,
  "getStatus" | "scan" | "listThreads" | "getThread" | "manageThread" | "pauseThread" | "resumeThread"
  | "stopManaging" | "sendInstruction" | "listInteractions" | "answerInteraction"
>;

export interface CodexRouteDependencies {
  service: CodexRouteService;
  requireOperator(request: Request): void;
}

export async function handleCodexRoutes(
  request: Request,
  url: URL,
  dependencies: CodexRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/codex")) return undefined;
  dependencies.requireOperator(request);
  try {
    if (request.method === "GET" && url.pathname === "/api/codex/status") {
      return json(dependencies.service.getStatus());
    }
    if (request.method === "POST" && url.pathname === "/api/codex/refresh") {
      await dependencies.service.scan();
      return json(dependencies.service.getStatus());
    }
    if (request.method === "GET" && url.pathname === "/api/codex/threads") {
      const mode = optionalEnum(url.searchParams.get("mode"), "mode", MODES);
      const phase = optionalEnum(url.searchParams.get("phase"), "phase", PHASES);
      const limit = queryInteger(url, "limit", 1, 500) ?? 100;
      const offset = queryInteger(url, "offset", 0, 1_000_000) ?? 0;
      return json({ threads: dependencies.service.listThreads({ mode, phase, limit, offset }) });
    }
    if (request.method === "GET" && url.pathname === "/api/codex/interactions") {
      const status = optionalEnum(url.searchParams.get("status"), "status", INTERACTION_STATUSES);
      const threadId = optionalString(url.searchParams.get("thread_id"), "thread_id", 200);
      const limit = queryInteger(url, "limit", 1, 500) ?? 100;
      return json({ interactions: dependencies.service.listInteractions({ thread_id: threadId, status, limit }) });
    }
    const threadMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)$/);
    if (request.method === "GET" && threadMatch) {
      return json(dependencies.service.getThread(decodeSegment(threadMatch[1]!, "thread id")));
    }
    const actionMatch = url.pathname.match(/^\/api\/codex\/threads\/([^/]+)\/(manage|pause|resume|stop|instructions)$/);
    if (request.method === "POST" && actionMatch) {
      const threadId = decodeSegment(actionMatch[1]!, "thread id");
      const action = actionMatch[2]!;
      const body = inputObject(await readJson(request, action === "instructions" ? 32_000 : 16_000));
      if (action === "manage") {
        const thread = await dependencies.service.manageThread({
          thread_id: threadId,
          expected_revision: requiredRevision(body.expected_revision),
          objective: requiredString(body.objective, "objective", CODEX_GOAL_OBJECTIVE_MAX_CHARS),
          token_budget: optionalNumber(body.token_budget, "token_budget", { minimum: 1, maximum: 2_000_000, integer: true }),
          deadline_at: optionalString(body.deadline_at, "deadline_at", 100),
          trigger: "web",
        });
        return json({ thread }, 202);
      }
      if (action === "instructions") {
        const directive = dependencies.service.sendInstruction({
          thread_id: threadId,
          content: requiredString(body.content, "content", 20_000),
          actor_id: "operator",
          channel: "web",
          idempotency_key: requiredString(body.idempotency_key, "idempotency_key", 200),
        });
        return json({ directive }, 202);
      }
      const revision = requiredRevision(body.expected_revision);
      const thread = action === "pause"
        ? await dependencies.service.pauseThread(threadId, revision)
        : action === "resume"
          ? await dependencies.service.resumeThread(threadId, revision)
          : dependencies.service.stopManaging(threadId, revision);
      return json({ thread });
    }
    const answerMatch = url.pathname.match(/^\/api\/codex\/interactions\/([^/]+)\/answer$/);
    if (request.method === "POST" && answerMatch) {
      const interactionId = decodeSegment(answerMatch[1]!, "interaction id");
      const interaction = findInteraction(dependencies.service, interactionId);
      if (interaction.kind === "approval") throw new HttpError(422, "System approvals are only accepted by the Web approval route");
      return json({ interaction: await dependencies.service.answerInteraction(answerInput(interactionId, await readJson(request, 24_000))) });
    }
    const approvalMatch = url.pathname.match(/^\/api\/codex\/approvals\/([^/]+)\/respond$/);
    if (request.method === "POST" && approvalMatch) {
      const interactionId = decodeSegment(approvalMatch[1]!, "approval id");
      const interaction = findInteraction(dependencies.service, interactionId);
      if (interaction.kind !== "approval") throw new HttpError(422, "Interaction is not an App Server approval");
      return json({ interaction: await dependencies.service.answerInteraction(answerInput(interactionId, await readJson(request, 24_000))) });
    }
    return undefined;
  } catch (error) {
    throw translate(error);
  }
}

function answerInput(id: string, value: unknown) {
  const body = inputObject(value);
  return {
    id,
    expected_revision: requiredRevision(body.expected_revision),
    selected_option_id: optionalString(body.selected_option_id, "selected_option_id", 100),
    response_text: optionalString(body.response_text, "response_text", 20_000),
  };
}

function findInteraction(service: CodexRouteService, id: string): CodexInteraction {
  const interaction = service.listInteractions({ limit: 500 }).find((item) => item.id === id);
  if (!interaction) throw new HttpError(404, `Codex interaction not found: ${id}`);
  return interaction;
}

function requiredRevision(value: unknown): number {
  const revision = optionalNumber(value, "expected_revision", { minimum: 1, integer: true });
  if (revision === undefined) throw new HttpError(400, "expected_revision is required");
  return revision;
}

function queryInteger(url: URL, name: string, minimum: number, maximum: number): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new HttpError(400, `${name} is invalid`);
  return parsed;
}

function decodeSegment(value: string, label: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, `${label} is not valid URL encoding`); }
}

function translate(error: unknown): Error {
  if (error instanceof HttpError) return error;
  if (error instanceof CodexSupervisorUnavailableError) return new HttpError(503, error.message);
  if (error instanceof CodexThreadUnmanageableError) return new HttpError(422, error.message);
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("revision conflict")) return new HttpError(409, message);
  if (normalized.includes("not found")) return new HttpError(404, message);
  if (normalized.includes("invalid") || normalized.includes("must") || normalized.includes("outside every registered")) {
    return new HttpError(422, message);
  }
  return error instanceof Error ? error : new Error(message);
}
