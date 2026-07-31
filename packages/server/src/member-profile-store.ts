import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentConfig } from "@totemora/core";
import type { MemberMemoryEvent } from "./member-state-store";
import { StateDatabase } from "./state-database";

export interface MemberConstitution {
  member_id: string;
  version: number;
  traits: string[];
  principles: string[];
  communication_style: string[];
  working_preferences: string[];
  red_lines: string[];
  approved_by: string;
  applied_at: string;
  proposal_id?: string;
}

export interface EvolutionProposal {
  id: string;
  member_id: string;
  base_version: number;
  status: "pending" | "approved" | "rejected" | "stale";
  proposed_by: string;
  reviewed_by?: string;
  proposed_changes: Partial<Pick<MemberConstitution, "traits" | "communication_style" | "working_preferences">>;
  evidence_ids: string[];
  rationale: string;
  expected_benefit: string;
  risks: string[];
  created_at: string;
  reviewed_at?: string;
  effect?: {
    changed_fields: string[];
    before_version: number;
    after_version: number;
    prompt_active_from: string;
    evaluation_status: "observing" | "ready_for_review" | "validated" | "rolled_back";
    target_credited_tasks: number;
    baseline: { experience_credit: number; member_failures: number; positive_feedback: number };
    observed_experience_credit?: number;
  };
}

export interface MemberPortrait {
  constitution: MemberConstitution;
  observed_traits: Array<{ name: string; score: number; confidence: number; evidence: string }>;
  task_record: { completed: number; accepted: number; experience_credit: number; member_failures: number; system_failures: number; success_rate: number };
  major_experiences: Array<{ title: string; summary: string; at: string; evidence_id?: string }>;
  evolution: { pending: EvolutionProposal[]; history: EvolutionProposal[]; active_effect?: EvolutionProposal["effect"] };
}

interface ProposalRow {
  id: string; member_id: string; base_version: number; status: EvolutionProposal["status"];
  payload_json: string; created_at: string; reviewed_at: string | null;
}

export class MemberProfileStore {
  private readonly state: StateDatabase;

  constructor(private readonly dataDir: string) {
    this.state = StateDatabase.open(dataDir);
    this.importLegacy();
  }

  async portrait(member: AgentConfig, events: MemberMemoryEvent[], counts: {
    successes: number; successCredit: number; memberFailures: number; systemFailures: number;
  }): Promise<MemberPortrait> {
    const constitution = await this.current(member);
    const proposals = (await this.listProposals(member.id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const judged = counts.successCredit + counts.memberFailures;
    const successRate = judged ? counts.successCredit / judged : 0;
    const confidence = Number((judged / (judged + 10)).toFixed(3));
    const helpCount = events.filter((item) => item.kind === "help_request").length;
    const activeProposal = proposals.find((item) => item.status === "approved" && item.effect);
    const activeEffect = activeProposal?.effect ? {
      ...activeProposal.effect,
      observed_experience_credit: Number(events
        .filter((item) => Date.parse(item.at) > Date.parse(activeProposal.effect!.prompt_active_from))
        .filter((item) => ["task_outcome", "user_feedback"].includes(item.credit_type ?? ""))
        .reduce((total, item) => total + (item.credit_value ?? 0), 0)
        .toFixed(2)),
    } : undefined;
    if (activeEffect && activeEffect.observed_experience_credit >= activeEffect.target_credited_tasks
      && activeEffect.evaluation_status === "observing") {
      activeEffect.evaluation_status = "ready_for_review";
    }
    return {
      constitution,
      observed_traits: [
        { name: "经验证的稳定度", score: Number(successRate.toFixed(3)), confidence, evidence: `${judged.toFixed(1)} 份可归因经验信用` },
        { name: "求助意识", score: helpCount ? Math.min(1, helpCount / Math.max(1, counts.memberFailures + helpCount)) : 0, confidence: Math.min(1, (helpCount + counts.memberFailures) / 10), evidence: `${helpCount} 次求助` },
        { name: "抗系统噪声", score: counts.systemFailures ? Number((counts.successCredit / Math.max(1, counts.successCredit + counts.systemFailures)).toFixed(3)) : 1, confidence: Math.min(1, (counts.successCredit + counts.systemFailures) / 20), evidence: `${counts.systemFailures} 次系统故障被隔离` },
      ],
      task_record: {
        completed: counts.successes + counts.memberFailures, accepted: counts.successes,
        experience_credit: Number(counts.successCredit.toFixed(2)),
        member_failures: counts.memberFailures, system_failures: counts.systemFailures,
        success_rate: Number(successRate.toFixed(3)),
      },
      major_experiences: majorExperiences(events, counts.successCredit),
      evolution: {
        pending: proposals.filter((item) => item.status === "pending"),
        history: proposals.filter((item) => item.status !== "pending"),
        active_effect: activeEffect,
      },
    };
  }

  async current(member: AgentConfig): Promise<MemberConstitution> {
    const row = this.state.db.query(`
      SELECT payload_json FROM member_constitutions WHERE member_id=? ORDER BY version DESC LIMIT 1
    `).get(member.id) as { payload_json: string } | null;
    return row ? JSON.parse(row.payload_json) as MemberConstitution : initialConstitution(member);
  }

  async createProposal(input: Omit<EvolutionProposal, "id" | "status" | "created_at">, validEvidenceIds: Set<string>): Promise<EvolutionProposal> {
    if (!input.evidence_ids.length || input.evidence_ids.some((id) => !validEvidenceIds.has(id))) {
      throw new Error("Evolution proposal contains missing or foreign evidence");
    }
    const proposal: EvolutionProposal = { ...input, id: crypto.randomUUID(), status: "pending", created_at: new Date().toISOString() };
    try {
      this.state.db.query(`
        INSERT INTO evolution_proposals(id,member_id,base_version,status,payload_json,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(proposal.id, proposal.member_id, proposal.base_version, proposal.status, JSON.stringify(proposal), proposal.created_at);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("Member already has a pending evolution proposal");
      throw error;
    }
    return proposal;
  }

  async review(member: AgentConfig, proposalId: string, reviewerId: string, approve: boolean): Promise<{ proposal: EvolutionProposal; constitution?: MemberConstitution }> {
    if (reviewerId === member.id) throw new Error("A member cannot review its own evolution proposal");
    return this.state.db.transaction(() => {
      const row = this.state.db.query(`
        SELECT * FROM evolution_proposals WHERE id=? AND member_id=?
      `).get(proposalId, member.id) as ProposalRow | null;
      if (!row || row.status !== "pending") throw new Error("Pending evolution proposal not found");
      const proposal = JSON.parse(row.payload_json) as EvolutionProposal;
      const currentRow = this.state.db.query(`
        SELECT payload_json FROM member_constitutions WHERE member_id=? ORDER BY version DESC LIMIT 1
      `).get(member.id) as { payload_json: string } | null;
      const current = currentRow ? JSON.parse(currentRow.payload_json) as MemberConstitution : initialConstitution(member);
      if (approve && proposal.base_version !== current.version) throw new Error("Evolution proposal base version is stale");
      const now = new Date().toISOString();
      proposal.status = approve ? "approved" : "rejected";
      proposal.reviewed_by = reviewerId;
      proposal.reviewed_at = now;
      if (!approve) {
        this.updateProposal(proposal);
        return { proposal };
      }
      const constitution: MemberConstitution = {
        ...current, ...proposal.proposed_changes, version: current.version + 1,
        approved_by: reviewerId, applied_at: now, proposal_id: proposal.id,
      };
      proposal.effect = {
        changed_fields: Object.keys(proposal.proposed_changes),
        before_version: current.version, after_version: constitution.version,
        prompt_active_from: now, evaluation_status: "observing", target_credited_tasks: 10,
        baseline: {
          experience_credit: Number((this.state.db.query(`
            SELECT COALESCE(SUM(credit_value),0) value FROM member_events
            WHERE member_id=? AND verified=1 AND credit_type IN ('task_outcome','user_feedback')
          `).get(member.id) as { value: number }).value.toFixed(2)),
          member_failures: (this.state.db.query(`
            SELECT COUNT(*) value FROM member_events WHERE member_id=? AND kind='failure'
          `).get(member.id) as { value: number }).value,
          positive_feedback: (this.state.db.query(`
            SELECT COUNT(*) value FROM member_events
            WHERE member_id=? AND credit_type='user_feedback' AND credit_value>0
          `).get(member.id) as { value: number }).value,
        },
      };
      this.state.db.query(`
        INSERT INTO member_constitutions(member_id,version,payload_json,approved_by,applied_at,proposal_id)
        VALUES(?,?,?,?,?,?)
      `).run(member.id, constitution.version, JSON.stringify(constitution), reviewerId, now, proposal.id);
      this.updateProposal(proposal);
      this.state.db.query(`
        INSERT INTO member_events(
          id,member_id,kind,credit_type,credit_value,verified,source_type,source_id,summary,at
        ) VALUES(?,?,'milestone','none',0,1,'evolution',?,?,?)
      `).run(
        crypto.randomUUID(), member.id, proposal.id,
        `成长生效：正式画像 v${current.version} → v${constitution.version}；下一次任务起提示词使用 ${proposal.effect.changed_fields.join("、")} 的新值，并观察后续 10 份经验信用。`,
        now,
      );
      return { proposal, constitution };
    })();
  }

  async listProposals(memberId: string): Promise<EvolutionProposal[]> {
    return (this.state.db.query(`
      SELECT * FROM evolution_proposals WHERE member_id=? ORDER BY created_at DESC
    `).all(memberId) as ProposalRow[]).map((row) => JSON.parse(row.payload_json) as EvolutionProposal);
  }

  private updateProposal(proposal: EvolutionProposal): void {
    this.state.db.query(`
      UPDATE evolution_proposals
      SET status=?,payload_json=?,reviewed_at=? WHERE id=?
    `).run(proposal.status, JSON.stringify(proposal), proposal.reviewed_at ?? null, proposal.id);
  }

  private importLegacy(): void {
    this.state.importJsonFile<EvolutionProposal>(
      resolve(this.dataDir, "member-evolution-proposals.json"),
      (value) => {
        if (!Array.isArray(value)) throw new Error("expected evolution proposal array");
        return value as EvolutionProposal[];
      },
      (proposal) => {
        const migrated = proposal.status === "pending"
          ? { ...proposal, status: "stale" as const, reviewed_at: new Date().toISOString() }
          : proposal;
        this.state.db.query(`
          INSERT OR IGNORE INTO evolution_proposals(id,member_id,base_version,status,payload_json,created_at,reviewed_at)
          VALUES(?,?,?,?,?,?,?)
        `).run(
          migrated.id, migrated.member_id, migrated.base_version, migrated.status,
          JSON.stringify(migrated), migrated.created_at, migrated.reviewed_at ?? null,
        );
      },
    );
    for (const file of safeList(resolve(this.dataDir, "member-revisions"))) {
      const path = resolve(this.dataDir, "member-revisions", file);
      this.state.importJsonFile<MemberConstitution>(
        path,
        (value) => [value as MemberConstitution],
        (constitution) => {
          this.state.db.query(`
            INSERT OR IGNORE INTO member_constitutions(member_id,version,payload_json,approved_by,applied_at,proposal_id)
            VALUES(?,?,?,?,?,?)
          `).run(
            constitution.member_id, constitution.version, JSON.stringify(constitution),
            constitution.approved_by, constitution.applied_at, constitution.proposal_id ?? null,
          );
        },
      );
    }
  }
}

function initialConstitution(member: AgentConfig): MemberConstitution {
  return {
    member_id: member.id, version: member.version ?? 1,
    traits: member.personality?.traits ?? [], principles: member.personality?.principles ?? [],
    communication_style: member.personality?.communication_style ?? [],
    working_preferences: member.personality?.working_preferences ?? [], red_lines: member.personality?.red_lines ?? [],
    approved_by: "tribe-config", applied_at: member.lifecycle?.born_at ?? new Date(0).toISOString(),
  };
}

function majorExperiences(events: MemberMemoryEvent[], credit: number): MemberPortrait["major_experiences"] {
  const milestones: MemberPortrait["major_experiences"] = events
    .filter((item) => item.kind === "milestone")
    .map((item) => ({ title: "部落里程碑", summary: item.summary, at: item.at, evidence_id: item.id }));
  const successEvents = events
    .filter((item) => item.verified && ["task_outcome", "user_feedback"].includes(item.credit_type ?? ""))
    .sort((a, b) => a.at.localeCompare(b.at));
  const firstSuccess = successEvents[0];
  if (firstSuccess) milestones.push({ title: "首次可信经验", summary: firstSuccess.summary, at: firstSuccess.at, evidence_id: firstSuccess.id });
  for (const threshold of [100, 50, 10]) {
    if (credit < threshold) continue;
    const evidence = successEvents[Math.min(successEvents.length - 1, threshold - 1)];
    if (evidence) milestones.push({
      title: `累计 ${threshold} 份经验信用`, summary: `在所属专业中累计获得至少 ${threshold} 份可归因经验信用。`,
      at: evidence.at, evidence_id: evidence.id,
    });
    break;
  }
  const firstGuidance = [...events].reverse().find((item) => item.kind === "guidance");
  if (firstGuidance) milestones.push({ title: "首次获得导师指点", summary: firstGuidance.summary, at: firstGuidance.at, evidence_id: firstGuidance.id });
  return milestones.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
}

function safeList(directory: string): string[] {
  try { return readdirSync(directory).filter((file) => file.endsWith(".json")); }
  catch { return []; }
}
