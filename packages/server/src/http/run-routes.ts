import { HttpError, json, readJson } from "./http-boundary";
import { requiredString } from "./input-schema";
import {
  intakeAnalysisInput,
  missionCreateInput,
  runRequestInput,
  type RunRouteInput,
} from "./run-input-schema";

export interface RunJobView {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  message: string;
  created_at: string;
  updated_at: string;
  mission_id?: string;
  run?: { task: { goal: string } };
  error?: string;
  failure?: unknown;
}

export interface RunRouteDependencies {
  createMission(input: { title: string; workplace_id?: string }): Promise<unknown>;
  analyzeTask(input: { goal: string; has_workspace: boolean; continuing: boolean }): unknown;
  enqueueRun(input: RunRouteInput): Promise<RunJobView>;
  listPersistedRuns(): Promise<unknown[]>;
  listJobs(): RunJobView[];
  getJob(id: string): RunJobView | undefined;
  getJobGoal(id: string): string | undefined;
  cancelRun(id: string): Promise<RunJobView>;
  retryRun(id: string): Promise<RunJobView>;
  requireOperator(request: Request): void;
}

export async function handleRunRoutes(
  request: Request,
  url: URL,
  dependencies: RunRouteDependencies,
): Promise<Response | undefined> {
  if (request.method === "POST" && url.pathname === "/api/missions") {
    dependencies.requireOperator(request);
    const input = missionCreateInput(await readJson(request, 8_000));
    return json(await translateMission(() => dependencies.createMission(input)), 201);
  }

  if (request.method === "POST" && url.pathname === "/api/intake/analyze") {
    const input = intakeAnalysisInput(await readJson(request, 16_000));
    return json(dependencies.analyzeTask({
      goal: input.goal,
      has_workspace: Boolean(input.workplace_id || input.workspace),
      continuing: Boolean(input.mission_id),
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    dependencies.requireOperator(request);
    return json(await dependencies.enqueueRun(
      runRequestInput(await readJson(request, 64_000)),
    ), 202);
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    return json({ runs: await dependencies.listPersistedRuns() });
  }

  if (request.method === "GET" && url.pathname === "/api/jobs") {
    return json({ jobs: dependencies.listJobs()
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 30)
      .map((job) => ({
        id: job.id, mission_id: job.mission_id, status: job.status,
        phase: job.phase, message: job.message, created_at: job.created_at,
        updated_at: job.updated_at, goal: job.run?.task.goal ?? dependencies.getJobGoal(job.id),
        error: job.error, failure: job.failure,
      })) });
  }

  const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    dependencies.requireOperator(request);
    return json(await dependencies.cancelRun(decodePathSegment(cancelMatch[1]!)), 202);
  }

  const retryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    dependencies.requireOperator(request);
    return json(await dependencies.retryRun(decodePathSegment(retryMatch[1]!)), 202);
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const job = dependencies.getJob(decodePathSegment(runMatch[1]!));
    return job ? json(job) : json({ error: "Run job not found" }, 404);
  }
  return undefined;
}

function decodePathSegment(value: string): string {
  try { return requiredString(decodeURIComponent(value), "Run id", 256); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Run id is not valid URL encoding");
  }
}

async function translateMission<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.message === "工作地不存在") {
      throw new HttpError(404, error.message);
    }
    throw error;
  }
}
