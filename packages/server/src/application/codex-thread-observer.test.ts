import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexThreadObserver } from "./codex-thread-observer";
import { CodexThreadRepository } from "../repositories/codex-thread-repository";
import { SettlementStore } from "../settlement-store";
import type { CodexThread } from "../integrations/codex-app-server-client";

test("observer sees every thread but only associates canonical registered workplaces", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "totemora-codex-observer-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "totemora-codex-observer-work-"));
  const child = join(workspace, "packages", "server");
  await mkdir(child, { recursive: true });
  try {
    const workplace = await new SettlementStore(dataDir).addWorkplace("Totemora", workspace);
    const appThreads = [thread("registered", child), thread("missing", join(workspace, "missing"))];
    const observer = new CodexThreadObserver({ listAllThreads: async () => appThreads }, dataDir);
    const result = await observer.scan();
    const repository = new CodexThreadRepository(dataDir);

    expect(result).toMatchObject({ observed: 2, registered: 1, managed: 0 });
    expect(repository.getRequired("registered").workplace_id).toBe(workplace.id);
    expect(repository.getRequired("missing").workplace_id).toBeUndefined();
    expect(repository.getRequired("registered").mode).toBe("observed");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

function thread(id: string, cwd: string): CodexThread {
  return {
    id, cwd, preview: id, source: { kind: "cli" }, status: { type: "idle" },
    createdAt: 1, updatedAt: 2, turns: [],
  };
}
