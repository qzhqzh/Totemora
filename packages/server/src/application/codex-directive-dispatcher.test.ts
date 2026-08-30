import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexDirectiveDispatcher } from "./codex-directive-dispatcher";
import type { CodexAppServerClient, CodexThread } from "../integrations/codex-app-server-client";
import { CodexDirectiveRepository } from "../repositories/codex-directive-repository";
import { CodexThreadRepository } from "../repositories/codex-thread-repository";
import { SettlementStore } from "../settlement-store";

test("thread preparation failures retry as known failures instead of uncertain delivery", async () => {
  const fixture = await dispatcherFixture();
  try {
    const client = {
      resumeManagedThread: async () => {
        throw new Error("Codex App Server message exceeds configured limit");
      },
    } as unknown as CodexAppServerClient;

    await fixture.dispatcher.dispatchQueued(client);
    await fixture.dispatcher.dispatchQueued(client);

    expect(fixture.directives.get(fixture.directiveId)).toMatchObject({
      status: "failed",
      attempts: 3,
      error: expect.stringContaining("preparation failed after 3 attempts"),
    });
    expect(fixture.threads.getRequired("thread-1")).toMatchObject({
      phase: "paused",
      next_action_at: undefined,
      last_error: expect.stringContaining("preparation failed after 3 attempts"),
    });
    expect(fixture.directives.counts().uncertain).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test("connection loss after turn delivery remains uncertain and fail-closed", async () => {
  const fixture = await dispatcherFixture();
  try {
    const client = {
      resumeManagedThread: async () => appThread(fixture.workspace),
      startManagedTurn: async () => {
        throw new Error("connection lost after request send");
      },
    } as unknown as CodexAppServerClient;

    await fixture.dispatcher.dispatchQueued(client);

    expect(fixture.directives.get(fixture.directiveId)).toMatchObject({
      status: "uncertain",
      error: "connection lost after request send",
    });
    expect(fixture.threads.getRequired("thread-1")).toMatchObject({
      phase: "paused",
      last_error: "Directive delivery is uncertain; operator review is required",
    });
  } finally {
    await fixture.close();
  }
});

async function dispatcherFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-codex-dispatcher-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "totemora-codex-dispatcher-work-"));
  const workplace = await new SettlementStore(dataDir).addWorkplace("Fixture", workspace);
  const threads = new CodexThreadRepository(dataDir);
  threads.observe([{ thread: appThread(workspace), workplace_id: workplace.id }]);
  const observed = threads.getRequired("thread-1");
  threads.manage({
    thread_id: observed.thread_id,
    expected_revision: observed.revision,
    workplace_id: workplace.id,
    objective: "finish safely",
    token_budget: 100,
    deadline_at: "2100-01-01T00:00:00.000Z",
    now: "2020-01-01T00:00:00.000Z",
  });
  const directives = new CodexDirectiveRepository(dataDir);
  const directive = directives.enqueue({
    thread_id: "thread-1",
    kind: "continue",
    content: "continue safely",
    actor_id: "supervisor",
    channel: "supervisor",
    idempotency_key: crypto.randomUUID(),
    available_at: "2020-01-01T00:00:00.000Z",
  });
  return {
    dataDir,
    workspace,
    threads,
    directives,
    directiveId: directive.id,
    dispatcher: new CodexDirectiveDispatcher(
      dataDir,
      "fixture-runner",
      () => new Date("2020-01-01T00:00:00.000Z"),
    ),
    close: async () => {
      await rm(dataDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

function appThread(cwd: string): CodexThread {
  return {
    id: "thread-1",
    cwd,
    preview: "fixture",
    source: { kind: "cli" },
    status: { type: "idle" },
    historyMode: "legacy",
    createdAt: 1,
    updatedAt: 2,
    turns: [],
  };
}
