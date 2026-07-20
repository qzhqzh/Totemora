import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AgentConfig, LocalConfigSet } from "@totemora/core";

export interface MemberMemoryEvent {
  id: string;
  member_id: string;
  kind: "conversation" | "success" | "failure" | "help_request" | "guidance" | "milestone";
  summary: string;
  verified: boolean;
  source_id?: string;
  at: string;
}

export interface MemberDossier {
  member: AgentConfig;
  identity: {
    age_days: number;
    rank: string;
    discipline: string;
    mentor?: { id: string; name: string };
  };
  growth: {
    verified_successes: number;
    failures: number;
    help_requests: number;
    guidance_received: number;
    vitality: number;
    next_review_after_runs: number;
    eligible_growth_proposal: boolean;
  };
  experiences: MemberMemoryEvent[];
}

export class MemberStateStore {
  private readonly memoryPath: string;
  private queue = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly config: LocalConfigSet) {
    this.memoryPath = resolve(dataDir, "member-memory.json");
  }

  async getDossier(memberId: string): Promise<MemberDossier> {
    const member = this.requireMember(memberId);
    const [memory, verified] = await Promise.all([this.listMemory(), this.loadVerifiedExperience(memberId)]);
    const events = [
      ...memory.filter((item) => item.member_id === memberId),
      ...verified.map((item, index) => ({
        id: String(item.id ?? `verified-${index}`), member_id: memberId,
        kind: "success" as const, summary: String(item.summary ?? "已验证任务"),
        verified: true, source_id: String(item.commit_sha ?? item.pr_url ?? ""),
        at: String(item.at ?? new Date(0).toISOString()),
      })),
    ].sort((left, right) => right.at.localeCompare(left.at));
    const born = Date.parse(member.lifecycle?.born_at ?? new Date().toISOString());
    const ageDays = Math.max(0, Math.floor((Date.now() - born) / 86_400_000));
    const halfLife = Math.max(1, member.lifecycle?.decay_half_life_days ?? 90);
    const lastVerifiedAt = events.find((item) => item.verified)?.at;
    const inactiveDays = lastVerifiedAt ? Math.max(0, (Date.now() - Date.parse(lastVerifiedAt)) / 86_400_000) : ageDays;
    const vitality = Math.max(0, Math.min(1, 2 ** (-inactiveDays / halfLife)));
    const successes = events.filter((item) => item.kind === "success" && item.verified).length;
    const reviewAfter = member.lifecycle?.review_after_runs ?? 10;
    const mentor = member.lineage?.mentor_id ? this.config.agents.agents.find((item) => item.id === member.lineage?.mentor_id) : undefined;
    return {
      member,
      identity: {
        age_days: ageDays,
        rank: member.lineage?.rank ?? "journeyman",
        discipline: member.lineage?.discipline ?? member.eligible_roles[0] ?? "general",
        mentor: mentor ? { id: mentor.id, name: mentor.name ?? mentor.id } : undefined,
      },
      growth: {
        verified_successes: successes,
        failures: events.filter((item) => item.kind === "failure").length,
        help_requests: events.filter((item) => item.kind === "help_request").length,
        guidance_received: events.filter((item) => item.kind === "guidance").length,
        vitality: Number(vitality.toFixed(3)),
        next_review_after_runs: successes > 0 && successes % reviewAfter === 0 ? 0 : Math.max(0, reviewAfter - (successes % reviewAfter)),
        eligible_growth_proposal: successes > 0 && successes % reviewAfter === 0,
      },
      experiences: events.slice(0, 30),
    };
  }

  async listDossiers(): Promise<MemberDossier[]> {
    return Promise.all(this.config.agents.agents.map((member) => this.getDossier(member.id)));
  }

  async remember(input: Omit<MemberMemoryEvent, "id" | "at">): Promise<MemberMemoryEvent> {
    const event: MemberMemoryEvent = { id: crypto.randomUUID(), at: new Date().toISOString(), ...input };
    const operation = this.queue.then(async () => {
      const records = await this.listMemory();
      records.push(event);
      await atomicWrite(this.memoryPath, records.slice(-2_000));
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return event;
  }

  private requireMember(id: string): AgentConfig {
    const member = this.config.agents.agents.find((item) => item.id === id);
    if (!member) throw new Error(`Member not found: ${id}`);
    return member;
  }

  private async listMemory(): Promise<MemberMemoryEvent[]> {
    try { return JSON.parse(await readFile(this.memoryPath, "utf8")) as MemberMemoryEvent[]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async loadVerifiedExperience(memberId: string): Promise<Array<Record<string, unknown>>> {
    try { return JSON.parse(await readFile(resolve(this.dataDir, "member-experience", `${memberId}.json`), "utf8")) as Array<Record<string, unknown>>; }
    catch { return []; }
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
