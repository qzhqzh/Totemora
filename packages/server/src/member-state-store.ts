import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentConfig, LocalConfigSet } from "@totemora/core";
import { MemberProfileStore, type MemberPortrait } from "./member-profile-store";
import { StateDatabase } from "./state-database";

export type ExperienceCreditType = "none" | "operation" | "task_outcome" | "user_feedback";

export interface MemberMemoryEvent {
  id: string;
  member_id: string;
  kind: "conversation" | "operation" | "success" | "failure" | "system_failure" | "help_request" | "guidance" | "milestone";
  summary: string;
  verified: boolean;
  source_id?: string;
  source_type?: string;
  credit_type?: ExperienceCreditType;
  credit_value?: number;
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
    experience_credit: number;
    operation_count: number;
    failures: number;
    system_failures: number;
    help_requests: number;
    guidance_received: number;
    vitality: number;
    next_review_after_runs: number;
    review_cooldown_days: number;
    eligible_growth_proposal: boolean;
  };
  portrait: MemberPortrait;
  experiences: MemberMemoryEvent[];
}

interface EventRow {
  id: string; member_id: string; kind: MemberMemoryEvent["kind"]; summary: string; verified: number;
  source_id: string | null; source_type: string; credit_type: ExperienceCreditType; credit_value: number; at: string;
}

export class MemberStateStore {
  readonly profiles: MemberProfileStore;
  private readonly state: StateDatabase;

  constructor(private readonly dataDir: string, private readonly config: LocalConfigSet) {
    this.state = StateDatabase.open(dataDir);
    this.profiles = new MemberProfileStore(dataDir);
    this.importLegacy();
  }

  async getDossier(memberId: string): Promise<MemberDossier> {
    const member = this.requireMember(memberId);
    const events = await this.listEvents(memberId);
    const born = Date.parse(member.lifecycle?.born_at ?? new Date().toISOString());
    const ageDays = Math.max(0, Math.floor((Date.now() - born) / 86_400_000));
    const halfLife = Math.max(1, member.lifecycle?.decay_half_life_days ?? 90);
    const lastCreditedAt = events.find((item) => growthCredit(item) > 0)?.at;
    const inactiveDays = lastCreditedAt ? Math.max(0, (Date.now() - Date.parse(lastCreditedAt)) / 86_400_000) : ageDays;
    const vitality = Math.max(0, Math.min(1, 2 ** (-inactiveDays / halfLife)));
    const creditedEvents = events.filter((item) => growthCredit(item) > 0);
    const credit = creditedEvents.reduce((total, item) => total + growthCredit(item), 0);
    const memberFailures = events.filter((item) => item.kind === "failure" && !isSystemFailureEvent(item));
    const systemFailures = events.filter(isSystemFailureEvent);
    const mentor = member.lineage?.mentor_id ? this.config.agents.agents.find((item) => item.id === member.lineage?.mentor_id) : undefined;
    const portrait = await this.profiles.portrait(member, events, {
      successes: creditedEvents.length, successCredit: credit,
      memberFailures: memberFailures.length, systemFailures: systemFailures.length,
    });
    const reviewStart = portrait.constitution.version > (member.version ?? 1) ? Date.parse(portrait.constitution.applied_at) : 0;
    const creditSinceReview = events
      .filter((item) => Date.parse(item.at) > reviewStart)
      .reduce((total, item) => total + growthCredit(item), 0);
    const reviewAfter = member.lifecycle?.review_after_runs ?? 10;
    const lastReviewAt = portrait.evolution.history[0]?.reviewed_at ?? portrait.constitution.applied_at;
    const cooldownDays = Math.max(0, 7 - Math.floor((Date.now() - Date.parse(lastReviewAt)) / 86_400_000));
    return {
      member,
      identity: {
        age_days: ageDays, rank: member.lineage?.rank ?? "journeyman",
        discipline: member.lineage?.discipline ?? member.eligible_roles[0] ?? "general",
        mentor: mentor ? { id: mentor.id, name: mentor.name ?? mentor.id } : undefined,
      },
      growth: {
        verified_successes: creditedEvents.length,
        experience_credit: Number(credit.toFixed(2)),
        operation_count: events.filter((item) => item.credit_type === "operation" || item.kind === "operation").length,
        failures: memberFailures.length, system_failures: systemFailures.length,
        help_requests: events.filter((item) => item.kind === "help_request").length,
        guidance_received: events.filter((item) => item.kind === "guidance").length,
        vitality: Number(vitality.toFixed(3)),
        next_review_after_runs: Math.max(0, Math.ceil(reviewAfter - creditSinceReview)),
        review_cooldown_days: cooldownDays,
        eligible_growth_proposal: creditSinceReview >= reviewAfter && cooldownDays === 0 && portrait.evolution.pending.length === 0,
      },
      portrait,
      experiences: events.slice(0, 30),
    };
  }

  async listDossiers(): Promise<MemberDossier[]> {
    return Promise.all(this.config.agents.agents.map((member) => this.getDossier(member.id)));
  }

  async remember(input: Omit<MemberMemoryEvent, "id" | "at">): Promise<MemberMemoryEvent> {
    const event: MemberMemoryEvent = {
      id: crypto.randomUUID(), at: new Date().toISOString(),
      credit_type: inferCreditType(input), credit_value: inferCreditValue(input),
      source_type: input.source_type ?? "runtime", ...input,
    };
    this.insert(event);
    return event;
  }

  async listEvents(memberId: string): Promise<MemberMemoryEvent[]> {
    this.requireMember(memberId);
    return (this.state.db.query(`
      SELECT * FROM member_events WHERE member_id=? ORDER BY at DESC
    `).all(memberId) as EventRow[]).map(fromRow);
  }

  private requireMember(id: string): AgentConfig {
    const member = this.config.agents.agents.find((item) => item.id === id);
    if (!member) throw new Error(`Member not found: ${id}`);
    return member;
  }

  private insert(event: MemberMemoryEvent): void {
    this.state.db.query(`
      INSERT OR IGNORE INTO member_events(
        id,member_id,kind,credit_type,credit_value,verified,source_type,source_id,summary,at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(
      event.id, event.member_id, event.kind, event.credit_type ?? inferCreditType(event),
      event.credit_value ?? inferCreditValue(event), event.verified ? 1 : 0,
      event.source_type ?? "runtime", event.source_id ?? null, event.summary, event.at,
    );
  }

  private importLegacy(): void {
    const sources = [
      resolve(this.dataDir, "member-memory.json"),
      ...safeList(resolve(this.dataDir, "member-memory")).map((name) => resolve(this.dataDir, "member-memory", name)),
    ];
    for (const source of sources) {
      this.state.importJsonFile<MemberMemoryEvent>(
        source,
        (value) => {
          if (!Array.isArray(value)) throw new Error("expected member event array");
          return value as MemberMemoryEvent[];
        },
        (event) => {
          const operation = isLegacyIntelligenceScan(event);
          this.insert({
            ...event,
            kind: operation ? "operation" : event.kind,
            source_type: "legacy_member_memory",
            credit_type: operation ? "operation" : inferCreditType(event),
            credit_value: operation ? 0 : inferCreditValue(event),
          });
        },
      );
    }
    for (const file of safeList(resolve(this.dataDir, "member-experience"))) {
      const memberId = file.replace(/\.json$/, "");
      const path = resolve(this.dataDir, "member-experience", file);
      this.state.importJsonFile<Record<string, unknown>>(
        path,
        (value) => {
          if (!Array.isArray(value)) throw new Error("expected member experience array");
          return value as Array<Record<string, unknown>>;
        },
        (value) => this.insert({
          id: String(value.id ?? crypto.randomUUID()), member_id: memberId, kind: "success",
          summary: String(value.summary ?? "已验证专业任务"), verified: true,
          source_id: String(value.commit_sha ?? value.pr_url ?? value.id ?? ""),
          source_type: "legacy_member_experience", credit_type: "task_outcome", credit_value: 1,
          at: String(value.at ?? new Date(0).toISOString()),
        }),
      );
    }
  }
}

function fromRow(row: EventRow): MemberMemoryEvent {
  return {
    id: row.id, member_id: row.member_id, kind: row.kind, summary: row.summary,
    verified: Boolean(row.verified), source_id: row.source_id ?? undefined,
    source_type: row.source_type, credit_type: row.credit_type, credit_value: row.credit_value, at: row.at,
  };
}

function inferCreditType(event: Pick<MemberMemoryEvent, "kind" | "verified" | "credit_type">): ExperienceCreditType {
  if (event.credit_type) return event.credit_type;
  return event.kind === "success" && event.verified ? "task_outcome" : "none";
}

function inferCreditValue(event: Pick<MemberMemoryEvent, "kind" | "verified" | "credit_value" | "credit_type">): number {
  if (typeof event.credit_value === "number") return event.credit_value;
  return inferCreditType(event) === "task_outcome" ? 1 : 0;
}

function growthCredit(event: MemberMemoryEvent): number {
  return event.verified && ["task_outcome", "user_feedback"].includes(event.credit_type ?? "")
    ? Math.max(0, event.credit_value ?? 0)
    : 0;
}

function isLegacyIntelligenceScan(event: MemberMemoryEvent): boolean {
  return event.kind === "success" && (
    event.summary.startsWith("完成情报扫描")
    || event.summary.startsWith("完成情报 ")
    || event.source_id?.startsWith("scan-") === true
  );
}

function safeList(directory: string): string[] {
  try { return readdirSync(directory).filter((file) => file.endsWith(".json")); }
  catch { return []; }
}

export function isSystemFailureEvent(event: MemberMemoryEvent): boolean {
  if (event.kind === "system_failure") return true;
  if (event.kind !== "failure") return false;
  return [
    "Action already completed", "Action is already executing", "Idempotency key was reused",
    "The operation timed out", "certificate verification", "News source failed",
  ].some((marker) => event.summary.includes(marker));
}
