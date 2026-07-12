import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ActiveSkillOverlay {
  skill_id: string;
  version: number;
  additions: string[];
  updated_at: string;
}

export interface SkillImprovementProposal {
  id: string;
  skill_id: string;
  base_version: number;
  status: "pending" | "approved" | "superseded";
  proposed_addition: string;
  evidence: { development_proposal_id: string; commit_sha: string };
  created_at: string;
  approved_at?: string;
}

export class SkillGovernanceStore {
  private readonly skillDir: string;
  private readonly proposalsDir: string;

  constructor(dataDir: string, private readonly skillId: string) {
    this.skillDir = resolve(dataDir, "skills", skillId);
    this.proposalsDir = resolve(dataDir, "skill-proposals");
  }

  async getActive(baseContent: string): Promise<{ version: number; content: string }> {
    const overlay = await this.readOverlay();
    const additions = overlay?.additions ?? [];
    return {
      version: overlay?.version ?? 1,
      content: additions.length
        ? `${baseContent.trim()}\n\n## 已批准的部落经验规则\n\n${additions.map((item) => `- ${item}`).join("\n")}\n`
        : baseContent,
    };
  }

  async propose(addition: string, evidence: SkillImprovementProposal["evidence"]): Promise<SkillImprovementProposal | undefined> {
    const normalized = addition.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    const active = await this.readOverlay();
    if (active?.additions.includes(normalized)) return undefined;
    const existing = await this.listProposals();
    if (existing.some((item) => item.status === "pending" && item.proposed_addition === normalized)) return undefined;
    const proposal: SkillImprovementProposal = {
      id: crypto.randomUUID(), skill_id: this.skillId,
      base_version: active?.version ?? 1, status: "pending",
      proposed_addition: normalized, evidence,
      created_at: new Date().toISOString(),
    };
    await mkdir(this.proposalsDir, { recursive: true });
    await atomicWrite(join(this.proposalsDir, `${proposal.id}.json`), proposal);
    return proposal;
  }

  async listProposals(): Promise<SkillImprovementProposal[]> {
    let files: string[];
    try { files = (await readdir(this.proposalsDir)).filter((file) => file.endsWith(".json")); }
    catch { return []; }
    const values = await Promise.all(files.map(async (file) => {
      try { return JSON.parse(await readFile(join(this.proposalsDir, file), "utf8")) as SkillImprovementProposal; }
      catch { return undefined; }
    }));
    return values.filter((item): item is SkillImprovementProposal => item?.skill_id === this.skillId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async approve(proposalId: string): Promise<ActiveSkillOverlay> {
    const path = join(this.proposalsDir, `${proposalId}.json`);
    let proposal: SkillImprovementProposal;
    try { proposal = JSON.parse(await readFile(path, "utf8")) as SkillImprovementProposal; }
    catch (error) { throw new Error(`Skill proposal not found: ${proposalId}`, { cause: error }); }
    if (proposal.status !== "pending") throw new Error(`Skill proposal cannot be approved from ${proposal.status}`);
    const active = await this.readOverlay() ?? {
      skill_id: this.skillId, version: 1, additions: [], updated_at: new Date().toISOString(),
    };
    if (active.version !== proposal.base_version) {
      proposal.status = "superseded";
      await atomicWrite(path, proposal);
      throw new Error("Skill changed after this proposal; regenerate it against the active version");
    }
    active.version += 1;
    active.additions.push(proposal.proposed_addition);
    active.updated_at = new Date().toISOString();
    await mkdir(this.skillDir, { recursive: true });
    await atomicWrite(join(this.skillDir, "active.json"), active);
    proposal.status = "approved";
    proposal.approved_at = active.updated_at;
    await atomicWrite(path, proposal);
    return active;
  }

  private async readOverlay(): Promise<ActiveSkillOverlay | undefined> {
    try { return JSON.parse(await readFile(join(this.skillDir, "active.json"), "utf8")) as ActiveSkillOverlay; }
    catch { return undefined; }
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
