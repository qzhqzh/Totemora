import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { CodexAppServerClient, CodexThread } from "../integrations/codex-app-server-client";
import type { Workplace } from "../settlement-store";
import { SettlementStore } from "../settlement-store";
import { CodexThreadRepository } from "../repositories/codex-thread-repository";

export interface CodexObservationResult {
  observed: number;
  registered: number;
  managed: number;
  scanned_at: string;
}

export class CodexThreadObserver {
  private readonly threads: CodexThreadRepository;
  private readonly settlement: SettlementStore;

  constructor(
    private readonly client: Pick<CodexAppServerClient, "listAllThreads">,
    dataDir: string,
  ) {
    this.threads = new CodexThreadRepository(dataDir);
    this.settlement = new SettlementStore(dataDir);
  }

  async scan(): Promise<CodexObservationResult> {
    const [appThreads, settlement] = await Promise.all([
      this.client.listAllThreads(),
      this.settlement.get(),
    ]);
    const pathCache = new Map<string, Promise<string | undefined>>();
    const snapshots = await Promise.all(appThreads.map(async (thread) => ({
      thread,
      workplace_id: findWorkplace(
        await canonicalPath(thread.cwd, pathCache),
        settlement.workplaces,
      )?.id,
    })));
    const scannedAt = new Date().toISOString();
    this.threads.observe(snapshots, scannedAt);
    return {
      observed: snapshots.length,
      registered: snapshots.filter((snapshot) => snapshot.workplace_id).length,
      managed: this.threads.counts().managed,
      scanned_at: scannedAt,
    };
  }

  async resolveRegisteredWorkplace(thread: CodexThread): Promise<Workplace | undefined> {
    const settlement = await this.settlement.get();
    const canonical = await canonicalPath(thread.cwd, new Map());
    return findWorkplace(canonical, settlement.workplaces);
  }
}

async function canonicalPath(
  path: string,
  cache: Map<string, Promise<string | undefined>>,
): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined;
  let pending = cache.get(path);
  if (!pending) {
    pending = realpath(resolve(path)).catch(() => undefined);
    cache.set(path, pending);
  }
  return pending;
}

function findWorkplace(canonicalCwd: string | undefined, workplaces: Workplace[]): Workplace | undefined {
  if (!canonicalCwd) return undefined;
  return workplaces
    .filter((workplace) => containsPath(workplace.path, canonicalCwd))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
