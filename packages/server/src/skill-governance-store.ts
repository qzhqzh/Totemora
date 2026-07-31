import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { StateDatabase } from "./state-database";

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
  private readonly state: StateDatabase;

  constructor(private readonly dataDir: string, private readonly skillId: string, private readonly baseVersion = 1) {
    this.state = StateDatabase.open(dataDir);
    this.importLegacy();
  }

  async getActive(baseContent: string): Promise<{ version: number; content: string }> {
    const overlay = await this.readOverlay();
    const additions = overlay?.additions ?? [];
    return {
      version: Math.max(overlay?.version ?? this.baseVersion, this.baseVersion),
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
      base_version: Math.max(active?.version ?? this.baseVersion, this.baseVersion), status: "pending",
      proposed_addition: normalized, evidence, created_at: new Date().toISOString(),
    };
    this.state.putRecord("skill_proposals", proposal.id, proposal, proposal.created_at, proposal.created_at);
    return proposal;
  }

  async listProposals(): Promise<SkillImprovementProposal[]> {
    return this.state.listRecords<SkillImprovementProposal>("skill_proposals")
      .filter((item) => item.skill_id === this.skillId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async approve(proposalId: string): Promise<ActiveSkillOverlay> {
    return this.state.db.transaction(() => {
      const proposal = this.state.listRecords<SkillImprovementProposal>("skill_proposals")
        .find((item) => item.id === proposalId);
      if (!proposal) throw new Error(`Skill proposal not found: ${proposalId}`);
      if (proposal.status !== "pending") throw new Error(`Skill proposal cannot be approved from ${proposal.status}`);
      const active = this.readOverlaySync() ?? {
        skill_id: this.skillId, version: this.baseVersion, additions: [], updated_at: new Date().toISOString(),
      };
      if (active.version !== proposal.base_version) {
        proposal.status = "superseded";
        this.state.putRecord("skill_proposals", proposal.id, proposal, proposal.created_at, new Date().toISOString());
        throw new Error("Skill changed after this proposal; regenerate it against the active version");
      }
      active.version += 1;
      active.additions.push(proposal.proposed_addition);
      active.updated_at = new Date().toISOString();
      proposal.status = "approved";
      proposal.approved_at = active.updated_at;
      this.state.putRecord("skill_overlays", this.skillId, active, active.updated_at, active.updated_at);
      this.state.putRecord("skill_proposals", proposal.id, proposal, proposal.created_at, active.updated_at);
      return active;
    })();
  }

  private async readOverlay(): Promise<ActiveSkillOverlay | undefined> {
    return this.readOverlaySync();
  }

  private readOverlaySync(): ActiveSkillOverlay | undefined {
    return this.state.listRecords<ActiveSkillOverlay>("skill_overlays")
      .find((item) => item.skill_id === this.skillId);
  }

  private importLegacy(): void {
    const overlayPath = resolve(this.dataDir, "skills", this.skillId, "active.json");
    this.state.importJsonFile<ActiveSkillOverlay>(
      overlayPath,
      (value) => [value as ActiveSkillOverlay],
      (overlay) => this.state.putRecord("skill_overlays", overlay.skill_id, overlay, overlay.updated_at, overlay.updated_at),
    );
    const directory = resolve(this.dataDir, "skill-proposals");
    let files: string[];
    try { files = readdirSync(directory).filter((file) => file.endsWith(".json")); }
    catch { files = []; }
    for (const file of files) {
      const path = resolve(directory, file);
      this.state.importJsonFile<SkillImprovementProposal>(
        path,
        (value) => [value as SkillImprovementProposal],
        (proposal) => this.state.putRecord("skill_proposals", proposal.id, proposal, proposal.created_at, proposal.approved_at ?? proposal.created_at),
      );
    }
  }
}
