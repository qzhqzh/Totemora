import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface Workplace {
  id: string;
  name: string;
  path: string;
  created_at: string;
  policy?: WorkplacePolicy;
}

export interface WorkplacePolicy {
  version: number;
  instructions: string;
  validation_commands: string[];
  allowed_commit_types: string[];
  forbidden_paths: string[];
  git_flow?: GitFlowPolicy;
  updated_at: string;
}

export interface GitFlowPolicy {
  remote_provider: "none" | "github";
  target_branch: string;
  allow_issue: boolean;
  allow_push: boolean;
  allow_pull_request: boolean;
  allow_merge: boolean;
  allow_opencode_fix: boolean;
}

export interface Mission {
  id: string;
  title: string;
  workplace_id?: string;
  status: "active" | "completed" | "paused";
  created_at: string;
  updated_at: string;
  requests: Array<{
    text: string;
    at: string;
    run_id?: string;
    outcome?: "completed" | "failed";
    result_summary?: string;
    error?: string;
  }>;
}

interface SettlementData {
  schema_version: 1;
  workplaces: Workplace[];
  missions: Mission[];
}

const EMPTY_SETTLEMENT: SettlementData = {
  schema_version: 1,
  workplaces: [],
  missions: [],
};

export class SettlementStore {
  private readonly filePath: string;
  private writeQueue = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = resolve(dataDir, "settlement.json");
  }

  async get(): Promise<SettlementData> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as SettlementData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_SETTLEMENT);
      throw error;
    }
  }

  async addWorkplace(name: string, path: string): Promise<Workplace> {
    if (!name.trim() || !path.trim()) throw new Error("工作地名称和路径不能为空");
    const workplace: Workplace = {
      id: crypto.randomUUID(), name: name.trim(), path: resolve(path),
      created_at: new Date().toISOString(),
    };
    await this.update((data) => {
      if (data.workplaces.some((item) => item.path === workplace.path)) {
        throw new Error("这个路径已经登记为工作地");
      }
      data.workplaces.push(workplace);
    });
    return workplace;
  }

  async setWorkplacePolicy(
    workplaceId: string,
    input: Omit<WorkplacePolicy, "version" | "updated_at">,
  ): Promise<WorkplacePolicy> {
    let result: WorkplacePolicy | undefined;
    await this.update((data) => {
      const workplace = data.workplaces.find((item) => item.id === workplaceId);
      if (!workplace) throw new Error("工作地不存在");
      if (!input.instructions.trim()) throw new Error("开发规范不能为空");
      result = {
        ...input,
        validation_commands: input.validation_commands.map((item) => item.trim()).filter(Boolean),
        allowed_commit_types: input.allowed_commit_types.length
          ? input.allowed_commit_types
          : ["feat", "fix", "docs", "refactor", "test", "chore"],
        forbidden_paths: input.forbidden_paths.map((item) => item.trim()).filter(Boolean),
        git_flow: input.git_flow ?? {
          remote_provider: "none",
          target_branch: "main",
          allow_issue: false,
          allow_push: false,
          allow_pull_request: false,
          allow_merge: false,
          allow_opencode_fix: false,
        },
        version: (workplace.policy?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
      };
      workplace.policy = result;
    });
    return result!;
  }

  async createMission(title: string, workplaceId?: string): Promise<Mission> {
    if (!title.trim()) throw new Error("Mission 标题不能为空");
    const now = new Date().toISOString();
    const mission: Mission = {
      id: crypto.randomUUID(), title: title.trim(), workplace_id: workplaceId || undefined,
      status: "active", created_at: now, updated_at: now, requests: [],
    };
    await this.update((data) => {
      if (workplaceId && !data.workplaces.some((item) => item.id === workplaceId)) {
        throw new Error("工作地不存在");
      }
      data.missions.push(mission);
    });
    return mission;
  }

  async addRequest(missionId: string, text: string, runId: string): Promise<void> {
    await this.update((data) => {
      const mission = data.missions.find((item) => item.id === missionId);
      if (!mission) throw new Error("Mission 不存在");
      const now = new Date().toISOString();
      mission.requests.push({ text, at: now, run_id: runId });
      mission.updated_at = now;
    });
  }

  async completeRequest(
    missionId: string,
    runId: string,
    result: { outcome: "completed" | "failed"; result_summary?: string; error?: string },
  ): Promise<void> {
    await this.update((data) => {
      const mission = data.missions.find((item) => item.id === missionId);
      const request = mission?.requests.find((item) => item.run_id === runId);
      if (!mission || !request) return;
      Object.assign(request, result);
      mission.updated_at = new Date().toISOString();
    });
  }

  private async update(mutator: (data: SettlementData) => void): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const data = await this.get();
      mutator(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}
