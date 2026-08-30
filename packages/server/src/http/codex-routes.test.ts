import { expect, test } from "bun:test";

import {
  CodexSupervisorUnavailableError,
  CodexThreadUnmanageableError,
} from "../application/codex-supervisor-service";
import type { CodexInteraction } from "../domains/codex/codex-supervisor-types";
import { handleCodexRoutes, type CodexRouteService } from "./codex-routes";
import { HttpError } from "./http-boundary";

test("Codex routes require operator auth and preserve bounded optimistic management input", async () => {
  const calls: unknown[] = [];
  const service = fakeService({
    manageThread: async (input: unknown) => {
      calls.push(input);
      return { thread_id: "thread-1", revision: 2 } as never;
    },
  });
  await expect(handle(new Request("http://local/api/codex/status"), service)).rejects.toMatchObject({ status: 401 });
  const response = await handle(new Request("http://local/api/codex/threads/thread-1/manage", {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify({ expected_revision: 1, objective: "finish", token_budget: 150_000 }),
  }), service);
  expect(response?.status).toBe(202);
  expect(calls).toEqual([expect.objectContaining({
    thread_id: "thread-1", expected_revision: 1, objective: "finish", token_budget: 150_000,
  })]);
});

test("generic decision route refuses App Server approvals while the Web approval route accepts them", async () => {
  const approval = interaction("approval");
  const calls: unknown[] = [];
  const service = fakeService({
    listInteractions: () => [approval],
    answerInteraction: async (input: unknown) => { calls.push(input); return { ...approval, status: "resolved" }; },
  });
  const body = JSON.stringify({ expected_revision: 1, selected_option_id: "decline" });
  await expect(handle(new Request(`http://local/api/codex/interactions/${approval.id}/answer`, {
    method: "POST", headers: authorized(), body,
  }), service)).rejects.toMatchObject({ status: 422 });
  const response = await handle(new Request(`http://local/api/codex/approvals/${approval.id}/respond`, {
    method: "POST", headers: authorized(), body,
  }), service);
  expect(response?.status).toBe(200);
  expect(calls).toEqual([expect.objectContaining({ id: approval.id, selected_option_id: "decline" })]);
});

test("Codex route translates disconnected mutation to 503", async () => {
  const service = fakeService({
    pauseThread: async () => { throw new CodexSupervisorUnavailableError("disconnected"); },
  });
  await expect(handle(new Request("http://local/api/codex/threads/thread-1/pause", {
    method: "POST", headers: authorized(), body: JSON.stringify({ expected_revision: 1 }),
  }), service)).rejects.toMatchObject({ status: 503 });
});

test("Codex route rejects unmanageable history and objectives beyond the App Server contract", async () => {
  const service = fakeService({
    manageThread: async () => {
      throw new CodexThreadUnmanageableError("Codex thread uses paginated history");
    },
  });
  await expect(handle(new Request("http://local/api/codex/threads/thread-1/manage", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ expected_revision: 1, objective: "finish" }),
  }), service)).rejects.toMatchObject({ status: 422 });
  await expect(handle(new Request("http://local/api/codex/threads/thread-1/manage", {
    method: "POST", headers: authorized(),
    body: JSON.stringify({ expected_revision: 1, objective: "x".repeat(4_001) }),
  }), fakeService({}))).rejects.toMatchObject({ status: 400 });
});

test("manual refresh scans the shared App Server before returning current status", async () => {
  let scans = 0;
  const service = fakeService({
    scan: async () => { scans += 1; },
    getStatus: () => ({
      enabled: true, connected: true, socket_path: "/socket", observed_threads: 2,
      running_threads: scans, managed_threads: 0, active_managed_threads: 0, open_interactions: 0,
      phase_counts: { observed: 2 }, directive_counts: {}, open_interaction_counts: {},
    }),
  });
  const response = await handle(new Request("http://local/api/codex/refresh", {
    method: "POST", headers: authorized(), body: "{}",
  }), service);

  expect(scans).toBe(1);
  expect(await response?.json()).toMatchObject({ running_threads: 1 });
});

function handle(request: Request, service: CodexRouteService) {
  return handleCodexRoutes(request, new URL(request.url), {
    service,
    requireOperator: (candidate) => {
      if (candidate.headers.get("authorization") !== "Bearer operator") throw new HttpError(401, "unauthorized");
    },
  });
}

function authorized(): HeadersInit {
  return { authorization: "Bearer operator", "content-type": "application/json" };
}

function fakeService(overrides: Partial<CodexRouteService>): CodexRouteService {
  return {
    getStatus: () => ({
      enabled: true, connected: true, socket_path: "/socket", observed_threads: 1,
      running_threads: 0, managed_threads: 0, active_managed_threads: 0, open_interactions: 0,
      phase_counts: { observed: 1 }, directive_counts: {}, open_interaction_counts: {},
    }),
    scan: async () => {},
    listThreads: () => [],
    getThread: () => ({ thread: {} as never, directives: [], interactions: [] }),
    manageThread: async () => ({} as never),
    pauseThread: async () => ({} as never),
    resumeThread: async () => ({} as never),
    stopManaging: () => ({} as never),
    sendInstruction: () => ({} as never),
    listInteractions: () => [],
    answerInteraction: async () => ({} as never),
    ...overrides,
  };
}

function interaction(kind: "approval" | "decision"): CodexInteraction {
  return {
    id: "interaction-1", thread_id: "thread-1", kind, status: "open", title: "Approve",
    body: "git push", options: [
      { id: "accept", label: "Accept", description: "once" },
      { id: "decline", label: "Decline", description: "deny" },
    ],
    source: "app_server", revision: 1, created_at: "2026-08-29", updated_at: "2026-08-29",
  };
}
