import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAgentCapabilityRepository } from "./codex-agent-capability-repository";
import { CodexDirectiveRepository } from "./codex-directive-repository";
import { CodexInteractionRepository } from "./codex-interaction-repository";
import { CodexLeaseRepository } from "./codex-lease-repository";
import { CodexThreadRepository } from "./codex-thread-repository";
import { StateDatabase } from "../state-database";
import type { CodexThread } from "../integrations/codex-app-server-client";

test("thread snapshots remain observed until an optimistic management handoff", async () => {
  const fixture = await repositoryFixture();
  try {
    fixture.threads.observe([{ thread: appThread("one", "/work/one"), workplace_id: "workplace-1" }], "2026-08-01T00:00:00Z");
    const observed = fixture.threads.getRequired("one");
    expect(observed).toMatchObject({ mode: "observed", phase: "observed", revision: 1 });

    fixture.threads.observe([{ thread: appThread("one", "/work/one"), workplace_id: "workplace-1" }], "2026-08-01T00:00:15Z");
    expect(fixture.threads.getRequired("one").revision).toBe(1);
    const managed = fixture.threads.manage({
      thread_id: "one",
      expected_revision: 1,
      workplace_id: "workplace-1",
      objective: "finish the implementation",
      token_budget: 150_000,
      deadline_at: "2026-08-04T00:00:00Z",
    });
    expect(managed).toMatchObject({ mode: "managed", phase: "aligning", revision: 2 });
    expect(managed.goal_status).toBeUndefined();
    expect(() => fixture.threads.manage({
      thread_id: "one", expected_revision: 1, workplace_id: "workplace-1",
      objective: "stale", token_budget: 1, deadline_at: "2026-08-04T00:00:00Z",
    })).toThrow("revision conflict");
  } finally {
    await fixture.close();
  }
});

test("thread snapshots persist App Server history mode changes", async () => {
  const fixture = await repositoryFixture();
  try {
    fixture.threads.observe([{
      thread: { ...appThread("one", "/work/one"), historyMode: "paginated" },
      workplace_id: "workplace-1",
    }], "2026-08-01T00:00:00Z");
    expect(fixture.threads.getRequired("one")).toMatchObject({ history_mode: "paginated", revision: 1 });

    fixture.threads.observe([{
      thread: { ...appThread("one", "/work/one"), historyMode: undefined },
      workplace_id: "workplace-1",
    }], "2026-08-01T00:00:10Z");
    expect(fixture.threads.getRequired("one")).toMatchObject({ history_mode: "paginated", revision: 1 });

    fixture.threads.observe([{
      thread: { ...appThread("one", "/work/one"), historyMode: "legacy" },
      workplace_id: "workplace-1",
    }], "2026-08-01T00:00:15Z");
    expect(fixture.threads.getRequired("one")).toMatchObject({ history_mode: "legacy", revision: 2 });
  } finally {
    await fixture.close();
  }
});

test("thread counts separate Codex runtime activity from Totemora supervision", async () => {
  const fixture = await repositoryFixture();
  try {
    fixture.threads.observe([
      { thread: appThread("idle", "/work/idle"), workplace_id: "workplace-idle" },
      { thread: { ...appThread("active", "/work/active"), status: { type: "active" } }, workplace_id: "workplace-active" },
    ]);
    expect(fixture.threads.counts()).toEqual({ observed: 2, running: 1, managed: 0, active_managed: 0 });

    const active = fixture.threads.getRequired("active");
    fixture.threads.manage({
      thread_id: "active", expected_revision: active.revision, workplace_id: "workplace-active",
      objective: "finish active", token_budget: 150_000,
      deadline_at: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
    });
    expect(fixture.threads.counts()).toEqual({ observed: 2, running: 1, managed: 1, active_managed: 1 });
  } finally {
    await fixture.close();
  }
});

test("directive delivery is idempotent, fenced, and fails closed after an uncertain lease", async () => {
  const fixture = await repositoryFixture();
  try {
    manageObserved(fixture.threads, "one", "/work/one");
    const directive = fixture.directives.enqueue({
      thread_id: "one", kind: "continue", content: "continue safely", actor_id: "operator",
      channel: "web", idempotency_key: "continue-1",
    });
    expect(fixture.directives.enqueue({
      thread_id: "one", kind: "continue", content: "continue safely", actor_id: "operator",
      channel: "web", idempotency_key: "continue-1",
    }).id).toBe(directive.id);
    const leased = fixture.directives.leaseNext("supervisor", 5_000)!;
    expect(leased).toMatchObject({ status: "leased", attempts: 1 });
    expect(() => fixture.directives.complete(leased.id, "wrong-fence")).toThrow("lease was lost");
    expect(fixture.directives.complete(leased.id, leased.lease_token!).status).toBe("completed");

    const uncertain = fixture.directives.enqueue({
      thread_id: "one", kind: "continue", content: "another", actor_id: "supervisor",
      channel: "supervisor", idempotency_key: "continue-2", available_at: "2020-01-01",
    });
    fixture.directives.leaseNext("supervisor", 5_000);
    expect(fixture.directives.markExpiredLeasesUncertain("2100-01-01")).toBe(1);
    expect(fixture.directives.get(uncertain.id)?.status).toBe("uncertain");
  } finally {
    await fixture.close();
  }
});

test("interaction policy separates reversible suggestions from decisions and approvals", async () => {
  const fixture = await repositoryFixture();
  try {
    manageObserved(fixture.threads, "one", "/work/one");
    const options = [
      { id: "a", label: "Proceed", description: "Use the reversible path" },
      { id: "b", label: "Pause", description: "Wait for the owner" },
    ];
    const suggest = fixture.interactions.create({
      thread_id: "one", kind: "suggest", title: "Choose next step", body: "The safe path is reversible.",
      options, recommendation_option_id: "a", default_option_id: "a", source: "agent",
      expires_at: "2026-08-01T02:00:00Z",
    });
    expect(fixture.interactions.applyExpired("2026-08-01T03:00:00Z")).toEqual({ defaulted: 1, expired: 0 });
    expect(fixture.interactions.get(suggest.id)).toMatchObject({ status: "defaulted", selected_option_id: "a" });
    expect(() => fixture.interactions.create({
      thread_id: "one", kind: "decision", title: "Irreversible choice", body: "Owner input required.",
      options, default_option_id: "a", source: "agent",
    })).toThrow("cannot have automatic defaults");

    const approval = fixture.interactions.create({
      thread_id: "one", kind: "approval", title: "Run command", body: "git push origin branch",
      options, source: "app_server", server_method: "item/commandExecution/requestApproval",
      server_request_id: 7, connection_id: "connection-1", params: { command: "git push" },
    });
    expect(fixture.interactions.markConnectionLost("connection-1")).toBe(1);
    expect(fixture.interactions.get(approval.id)?.status).toBe("manual_attention");
  } finally {
    await fixture.close();
  }
});

test("thread and canonical-worktree leases enforce fencing and global concurrency", async () => {
  const fixture = await repositoryFixture();
  try {
    manageObserved(fixture.threads, "one", "/work/one");
    manageObserved(fixture.threads, "two", "/work/two");
    manageObserved(fixture.threads, "three", "/work/three");
    const first = fixture.leases.acquirePair({
      thread_id: "one", canonical_worktree: "/work/one", owner_id: "runner-a", max_concurrency: 2,
    });
    expect(() => fixture.leases.acquirePair({
      thread_id: "two", canonical_worktree: "/work/one", owner_id: "runner-b", max_concurrency: 2,
    })).toThrow("held by another supervisor");
    fixture.leases.acquirePair({
      thread_id: "two", canonical_worktree: "/work/two", owner_id: "runner-b", max_concurrency: 2,
    });
    expect(() => fixture.leases.acquirePair({
      thread_id: "three", canonical_worktree: "/work/three", owner_id: "runner-c", max_concurrency: 2,
    })).toThrow("concurrency limit");
    fixture.leases.release(first);
    const reacquired = fixture.leases.acquirePair({
      thread_id: "one", canonical_worktree: "/work/one", owner_id: "runner-c", max_concurrency: 2,
    });
    expect(reacquired.worktree.fencing_token).toBeGreaterThan(first.worktree.fencing_token);
  } finally {
    await fixture.close();
  }
});

test("agent capability tokens are short-lived and only hashes are persisted", async () => {
  const fixture = await repositoryFixture();
  try {
    manageObserved(fixture.threads, "one", "/work/one");
    const issued = fixture.capabilities.mint("one", "turn-1", 60_000);
    expect(fixture.capabilities.verify(issued.token)).toEqual(issued.capability);
    const stored = StateDatabase.open(fixture.dataDir).db.query(`
      SELECT token_hash FROM codex_agent_capabilities WHERE thread_id='one'
    `).get() as { token_hash: string };
    expect(stored.token_hash).not.toContain(issued.token);
    fixture.capabilities.revokeTurn("one", "turn-1");
    expect(fixture.capabilities.verify(issued.token)).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

async function repositoryFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-codex-repositories-"));
  return {
    dataDir,
    threads: new CodexThreadRepository(dataDir),
    directives: new CodexDirectiveRepository(dataDir),
    interactions: new CodexInteractionRepository(dataDir),
    leases: new CodexLeaseRepository(dataDir),
    capabilities: new CodexAgentCapabilityRepository(dataDir),
    close: () => rm(dataDir, { recursive: true, force: true }),
  };
}

function manageObserved(repository: CodexThreadRepository, id: string, cwd: string): void {
  repository.observe([{ thread: appThread(id, cwd), workplace_id: `workplace-${id}` }]);
  const thread = repository.getRequired(id);
  repository.manage({
    thread_id: id, expected_revision: thread.revision, workplace_id: `workplace-${id}`,
    objective: `finish ${id}`, token_budget: 150_000,
    deadline_at: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
  });
}

function appThread(id: string, cwd: string): CodexThread {
  return {
    id, cwd, name: `Thread ${id}`, preview: "work in progress", source: { kind: "cli" },
    status: { type: "idle" }, historyMode: "legacy", createdAt: 1, updatedAt: 2, turns: [],
  };
}
