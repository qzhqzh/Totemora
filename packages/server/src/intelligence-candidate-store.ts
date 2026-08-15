import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { StateDatabase } from "./state-database";

export type CandidateStatus =
  | "queued" | "held" | "pushing" | "retry_wait" | "channel_blocked"
  | "pushed" | "failed" | "delivery_unknown";
export type CandidateFeedbackSignal = "valuable" | "not_valuable" | "duplicate" | "too_late" | "opened";
export type IntelligenceDomain = "ai" | "finance";
export type EvidenceTier = "S0" | "S1" | "S2" | "S3" | "S4";

export interface IntelligenceCandidate {
  id: string;
  domain: IntelligenceDomain;
  scan_id: string;
  member_id: string;
  event_key: string;
  headline: string;
  brief: string;
  url: string;
  source: string;
  source_id?: string;
  market?: string;
  symbols: string[];
  event_type?: string;
  evidence_tier?: EvidenceTier;
  scores: {
    importance: number;
    interest: number;
    confidence: number;
    novelty: number;
    base_total: number;
    feedback_adjustment: number;
    total: number;
  };
  rationale: string;
  is_update: boolean;
  status: CandidateStatus;
  decision: string;
  duplicate_of?: string;
  attempt_count: number;
  next_attempt_at?: string;
  claim_token?: string;
  created_at: string;
  updated_at: string;
  pushed_at?: string;
  error?: string;
  feedback?: Partial<Record<CandidateFeedbackSignal, number>>;
}

export interface CandidateEvaluation {
  event_key: string;
  headline: string;
  brief: string;
  url: string;
  source: string;
  source_id?: string;
  market?: string;
  symbols?: string[];
  event_type?: string;
  evidence_tier?: EvidenceTier;
  importance: number;
  interest: number;
  confidence: number;
  novelty: number;
  push_worthy: boolean;
  rationale: string;
  is_update: boolean;
}

export interface SourceEvidenceCandidate {
  title: string;
  link: string;
}

interface CandidateRow {
  id: string; domain: IntelligenceDomain; scan_id: string; member_id: string; event_key: string; headline: string; brief: string;
  url: string; source: string; importance: number; interest: number; confidence: number; novelty: number;
  source_id: string | null; market: string | null; symbols_json: string; event_type: string | null; evidence_tier: EvidenceTier | null;
  base_total: number; feedback_adjustment: number; total: number; rationale: string; is_update: number;
  status: CandidateStatus; decision: string; duplicate_of: string | null; attempt_count: number;
  next_attempt_at: string | null; claim_token: string | null; created_at: string; updated_at: string;
  pushed_at: string | null; error: string | null;
  duplicate_feedback?: number;
}

export class IntelligenceCandidateStore {
  private readonly state: StateDatabase;

  constructor(private readonly dataDir: string) {
    this.state = StateDatabase.open(dataDir);
    this.importLegacy();
  }

  async ingest(input: {
    domain?: IntelligenceDomain;
    scan_id: string;
    member_id: string;
    evaluations: CandidateEvaluation[];
    push_threshold: number;
    history_hours: number;
    now?: Date;
  }): Promise<IntelligenceCandidate[]> {
    const now = input.now ?? new Date();
    const domain = input.domain ?? "ai";
    const cutoff = new Date(now.getTime() - input.history_hours * 3_600_000).toISOString();
    return this.state.db.transaction(() => input.evaluations.map((evaluation) => {
      const priorRows = this.state.db.query(`
        SELECT c.*,EXISTS(
          SELECT 1 FROM candidate_feedback f WHERE f.candidate_id=c.id AND f.signal='duplicate'
        ) duplicate_feedback
        FROM intelligence_candidates c
        WHERE c.domain = ? AND c.created_at >= ? AND (c.event_key = ? OR c.url = ?)
        ORDER BY created_at DESC LIMIT 20
      `).all(domain, cutoff, evaluation.event_key, evaluation.url) as CandidateRow[];
      const nearbyRows = this.state.db.query(`
        SELECT c.*,EXISTS(
          SELECT 1 FROM candidate_feedback f WHERE f.candidate_id=c.id AND f.signal='duplicate'
        ) duplicate_feedback
        FROM intelligence_candidates c
        WHERE c.domain = ? AND c.created_at >= ? AND c.source = ?
        ORDER BY created_at DESC LIMIT 100
      `).all(domain, cutoff, evaluation.source) as CandidateRow[];
      const prior = [...priorRows, ...nearbyRows].find((row, index, rows) =>
        rows.findIndex((candidate) => candidate.id === row.id) === index
        && (
          isSameEvent(fromRow(row), evaluation)
          || (Boolean(row.duplicate_feedback) && ngramSimilarity(row.headline, evaluation.headline) >= 0.58)
        )
        && ["queued", "pushing", "retry_wait", "channel_blocked", "pushed", "failed", "delivery_unknown"].includes(row.status),
      );
      const baseTotal = weightedScore(evaluation);
      const adjustment = this.feedbackAdjustment(domain, evaluation, cutoff);
      const total = clampScore(baseTotal + adjustment);
      const substantiveUpdate = Boolean(prior?.status === "pushed" && evaluation.is_update && evaluation.novelty >= 0.75);
      const eligible = evaluation.push_worthy && total >= input.push_threshold && evaluation.confidence >= 0.55
        && evaluation.novelty >= 0.45 && (!prior || substantiveUpdate);
      const decision = prior && !substantiveUpdate
        ? `与候选 ${prior.id} 属于同一事件，等待新事实`
        : eligible
          ? `达到推送阈值 ${input.push_threshold}${adjustment ? `（用户反馈校正 ${signed(adjustment)}）` : ""}`
          : `价值或新颖度未达到推送阈值 ${input.push_threshold}`;
      const candidate: IntelligenceCandidate = {
        id: crypto.randomUUID(), domain, scan_id: input.scan_id, member_id: input.member_id,
        event_key: evaluation.event_key, headline: evaluation.headline, brief: evaluation.brief,
        url: evaluation.url, source: evaluation.source, source_id: evaluation.source_id,
        market: evaluation.market, symbols: normalizeSymbols(evaluation.symbols),
        event_type: evaluation.event_type, evidence_tier: evaluation.evidence_tier,
        scores: {
          importance: clamp(evaluation.importance), interest: clamp(evaluation.interest),
          confidence: clamp(evaluation.confidence), novelty: clamp(evaluation.novelty),
          base_total: baseTotal, feedback_adjustment: adjustment, total,
        },
        rationale: evaluation.rationale, is_update: evaluation.is_update,
        status: eligible ? "queued" : "held", decision,
        duplicate_of: prior && !substantiveUpdate ? prior.id : undefined,
        attempt_count: 0, created_at: now.toISOString(), updated_at: now.toISOString(),
      };
      this.insert(candidate);
      return candidate;
    }))();
  }

  async claimNext(minimumIntervalMs: number, now = new Date(), domain?: IntelligenceDomain): Promise<IntelligenceCandidate | undefined> {
    return this.state.db.transaction(() => {
      const staleCutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
      this.state.db.query(`
        UPDATE intelligence_candidates
        SET status='delivery_unknown',
            decision='服务在外发确认前中断；为避免重复打扰，不自动重推',
            claim_token=NULL, updated_at=?
        WHERE status='pushing' AND (claimed_at IS NULL OR claimed_at <= ?)
          AND (? IS NULL OR domain = ?)
      `).run(now.toISOString(), staleCutoff, domain ?? null, domain ?? null);
      const inFlight = this.state.db.query(`
        SELECT 1 active FROM intelligence_candidates
        WHERE status='pushing' AND (? IS NULL OR domain = ?) LIMIT 1
      `).get(domain ?? null, domain ?? null) as { active: number } | null;
      if (inFlight) return undefined;
      const last = this.state.db.query(`
        SELECT pushed_at FROM intelligence_candidates
        WHERE pushed_at IS NOT NULL AND (? IS NULL OR domain = ?) ORDER BY pushed_at DESC LIMIT 1
      `).get(domain ?? null, domain ?? null) as { pushed_at: string } | null;
      if (last && now.getTime() - Date.parse(last.pushed_at) < minimumIntervalMs) return undefined;
      const row = this.state.db.query(`
        SELECT * FROM intelligence_candidates
        WHERE status IN ('queued','retry_wait')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (? IS NULL OR domain = ?)
        ORDER BY total DESC, created_at ASC LIMIT 1
      `).get(now.toISOString(), domain ?? null, domain ?? null) as CandidateRow | null;
      if (!row) return undefined;
      const token = crypto.randomUUID();
      const result = this.state.db.query(`
        UPDATE intelligence_candidates
        SET status='pushing', claim_token=?, claimed_at=?, attempt_count=attempt_count+1, updated_at=?
        WHERE id=? AND status IN ('queued','retry_wait')
      `).run(token, now.toISOString(), now.toISOString(), row.id);
      if (result.changes !== 1) return undefined;
      return fromRow({ ...row, status: "pushing", claim_token: token, attempt_count: row.attempt_count + 1, updated_at: now.toISOString() });
    })();
  }

  async complete(id: string, claimTokenOrNow?: string | Date, suppliedNow = new Date()): Promise<void> {
    const claimToken = typeof claimTokenOrNow === "string" ? claimTokenOrNow : undefined;
    const now = claimTokenOrNow instanceof Date ? claimTokenOrNow : suppliedNow;
    const where = claimToken ? "id=? AND claim_token=?" : "id=?";
    const args = claimToken ? [id, claimToken] : [id];
    const result = this.state.db.query(`
      UPDATE intelligence_candidates
      SET status='pushed', pushed_at=?, updated_at=?, error=NULL, claim_token=NULL, next_attempt_at=NULL
      WHERE ${where}
    `).run(now.toISOString(), now.toISOString(), ...args);
    if (result.changes !== 1) throw new Error(`Intelligence candidate claim was lost: ${id}`);
  }

  async retry(id: string, claimToken: string | undefined, error: string, retryAt: Date, now = new Date()): Promise<void> {
    this.finishFailure(id, claimToken, "retry_wait", error, retryAt.toISOString(), now);
  }

  async block(id: string, claimToken: string | undefined, error: string, retryAt: Date, now = new Date()): Promise<void> {
    const where = claimToken ? "id=? AND claim_token=?" : "id=?";
    const args = claimToken ? [id, claimToken] : [id];
    const result = this.state.db.query(`
      UPDATE intelligence_candidates
      SET status='channel_blocked', error=?, next_attempt_at=?, updated_at=?, claim_token=NULL,
          attempt_count=MAX(0, attempt_count-1)
      WHERE ${where}
    `).run(error.slice(0, 500), retryAt.toISOString(), now.toISOString(), ...args);
    if (result.changes !== 1) throw new Error(`Intelligence candidate claim was lost: ${id}`);
  }

  async fail(id: string, error: string, now = new Date(), claimToken?: string): Promise<void> {
    this.finishFailure(id, claimToken, "failed", error, null, now);
  }

  async releaseBlocked(now = new Date()): Promise<number> {
    return this.state.db.query(`
      UPDATE intelligence_candidates SET status='retry_wait', updated_at=?
      WHERE status='channel_blocked' AND next_attempt_at <= ?
    `).run(now.toISOString(), now.toISOString()).changes;
  }

  async recordFeedback(
    id: string,
    signal: CandidateFeedbackSignal,
    source: "web" | "bark_click" | "telegram",
  ): Promise<{ candidate: IntelligenceCandidate; inserted: boolean }> {
    const candidate = await this.get(id);
    if (!candidate) throw new Error(`Intelligence candidate not found: ${id}`);
    const result = this.state.db.query(`
      INSERT OR IGNORE INTO candidate_feedback(id,candidate_id,signal,source,created_at)
      VALUES(?,?,?,?,?)
    `).run(crypto.randomUUID(), id, signal, source, new Date().toISOString());
    return { candidate: (await this.get(id))!, inserted: result.changes === 1 };
  }

  createOpenCallback(candidateId: string, targetUrl: string): string {
    assertSafeExternalUrl(targetUrl);
    const token = randomBytes(24).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    this.state.db.query(`
      INSERT INTO feedback_callbacks(token_hash,candidate_id,target_url,created_at)
      VALUES(?,?,?,?)
      ON CONFLICT(token_hash) DO NOTHING
    `).run(hash, candidateId, targetUrl, new Date().toISOString());
    return token;
  }

  async consumeOpenCallback(token: string): Promise<{ target_url: string; candidate_id: string; inserted: boolean } | undefined> {
    const hash = createHash("sha256").update(token).digest("hex");
    return this.state.db.transaction(() => {
      const row = this.state.db.query(`
        SELECT candidate_id,target_url,opened_at FROM feedback_callbacks WHERE token_hash=?
      `).get(hash) as { candidate_id: string; target_url: string; opened_at: string | null } | null;
      if (!row) return undefined;
      try { assertSafeExternalUrl(row.target_url); } catch { return undefined; }
      const inserted = this.state.db.query(`
        INSERT OR IGNORE INTO candidate_feedback(id,candidate_id,signal,source,created_at)
        VALUES(?,?,'opened','bark_click',?)
      `).run(crypto.randomUUID(), row.candidate_id, new Date().toISOString()).changes === 1;
      if (!row.opened_at) {
        this.state.db.query("UPDATE feedback_callbacks SET opened_at=? WHERE token_hash=?")
          .run(new Date().toISOString(), hash);
      }
      return { target_url: row.target_url, candidate_id: row.candidate_id, inserted };
    })();
  }

  async get(id: string): Promise<IntelligenceCandidate | undefined> {
    const row = this.state.db.query("SELECT * FROM intelligence_candidates WHERE id=?").get(id) as CandidateRow | null;
    return row ? this.withFeedback(fromRow(row)) : undefined;
  }

  async list(limit = 200, domain?: IntelligenceDomain): Promise<IntelligenceCandidate[]> {
    const rows = this.state.db.query(`
      SELECT * FROM intelligence_candidates
      WHERE (? IS NULL OR domain = ?)
      ORDER BY created_at DESC LIMIT ?
    `).all(domain ?? null, domain ?? null, Math.max(1, Math.min(1_000, limit))) as CandidateRow[];
    return rows.map((row) => this.withFeedback(fromRow(row)));
  }

  async counts(domain?: IntelligenceDomain): Promise<Record<CandidateStatus, number>> {
    const counts = {
      queued: 0, held: 0, pushing: 0, retry_wait: 0, channel_blocked: 0,
      pushed: 0, failed: 0, delivery_unknown: 0,
    } satisfies Record<CandidateStatus, number>;
    const rows = this.state.db.query(`
      SELECT status,COUNT(*) count FROM intelligence_candidates
      WHERE (? IS NULL OR domain = ?)
      GROUP BY status
    `).all(domain ?? null, domain ?? null) as Array<{ status: CandidateStatus; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  async filterNovelEvidence<T extends SourceEvidenceCandidate>(input: {
    domain: IntelligenceDomain;
    evidence: T[];
    history_hours: number;
    now?: Date;
  }): Promise<{ novel: T[]; suppressed: Array<{ evidence: T; candidate_id: string }> }> {
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - input.history_hours * 3_600_000).toISOString();
    const rows = this.state.db.query(`
      SELECT id,url,headline FROM intelligence_candidates
      WHERE domain=? AND created_at>=?
      ORDER BY created_at DESC LIMIT 1000
    `).all(input.domain, cutoff) as Array<{ id: string; url: string; headline: string }>;
    const novel: T[] = [];
    const suppressed: Array<{ evidence: T; candidate_id: string }> = [];
    for (const evidence of input.evidence) {
      const duplicate = rows.find((row) => {
        const similarity = ngramSimilarity(row.headline, evidence.title);
        return similarity >= 0.68 || (row.url === evidence.link && similarity >= 0.58);
      });
      if (duplicate) suppressed.push({ evidence, candidate_id: duplicate.id });
      else novel.push(evidence);
    }
    return { novel, suppressed };
  }

  private finishFailure(id: string, claimToken: string | undefined, status: CandidateStatus, error: string, retryAt: string | null, now: Date): void {
    const where = claimToken ? "id=? AND claim_token=?" : "id=?";
    const args = claimToken ? [id, claimToken] : [id];
    const result = this.state.db.query(`
      UPDATE intelligence_candidates
      SET status=?, error=?, next_attempt_at=?, updated_at=?, claim_token=NULL
      WHERE ${where}
    `).run(status, error.slice(0, 500), retryAt, now.toISOString(), ...args);
    if (result.changes !== 1) throw new Error(`Intelligence candidate claim was lost: ${id}`);
  }

  private feedbackAdjustment(domain: IntelligenceDomain, evaluation: CandidateEvaluation, cutoff: string): number {
    const rows = this.state.db.query(`
      SELECT c.event_key,c.url,c.headline,c.source,f.signal
      FROM candidate_feedback f JOIN intelligence_candidates c ON c.id=f.candidate_id
      WHERE c.domain = ? AND f.created_at >= ?
      ORDER BY f.created_at DESC LIMIT 500
    `).all(domain, cutoff) as Array<{ event_key: string; url: string; headline: string; source: string; signal: CandidateFeedbackSignal }>;
    let adjustment = 0;
    let matches = 0;
    for (const row of rows) {
      const similar = row.event_key === evaluation.event_key || row.url === evaluation.url
        || (row.source === evaluation.source && ngramSimilarity(row.headline, evaluation.headline) >= 0.58);
      if (!similar) continue;
      adjustment += FEEDBACK_WEIGHT[row.signal];
      matches += 1;
      if (matches >= 8) break;
    }
    return Number(Math.max(-0.15, Math.min(0.12, adjustment)).toFixed(3));
  }

  private withFeedback(candidate: IntelligenceCandidate): IntelligenceCandidate {
    const rows = this.state.db.query(`
      SELECT signal,COUNT(*) count FROM candidate_feedback WHERE candidate_id=? GROUP BY signal
    `).all(candidate.id) as Array<{ signal: CandidateFeedbackSignal; count: number }>;
    return { ...candidate, feedback: Object.fromEntries(rows.map((row) => [row.signal, row.count])) };
  }

  private insert(candidate: IntelligenceCandidate): void {
    this.state.db.query(`
      INSERT OR IGNORE INTO intelligence_candidates(
        id,domain,scan_id,member_id,event_key,headline,brief,url,source,source_id,market,symbols_json,event_type,evidence_tier,
        importance,interest,confidence,novelty,base_total,feedback_adjustment,total,
        rationale,is_update,status,decision,duplicate_of,attempt_count,next_attempt_at,
        claim_token,created_at,updated_at,pushed_at,error
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      candidate.id, candidate.domain ?? "ai", candidate.scan_id, candidate.member_id, candidate.event_key, candidate.headline,
      candidate.brief, candidate.url, candidate.source, candidate.source_id ?? null, candidate.market ?? null,
      JSON.stringify(normalizeSymbols(candidate.symbols)), candidate.event_type ?? null, candidate.evidence_tier ?? null,
      candidate.scores.importance,
      candidate.scores.interest, candidate.scores.confidence, candidate.scores.novelty,
      candidate.scores.base_total ?? candidate.scores.total, candidate.scores.feedback_adjustment ?? 0,
      candidate.scores.total, candidate.rationale, candidate.is_update ? 1 : 0, candidate.status,
      candidate.decision, candidate.duplicate_of ?? null, candidate.attempt_count ?? 0,
      candidate.next_attempt_at ?? null, candidate.claim_token ?? null, candidate.created_at,
      candidate.updated_at, candidate.pushed_at ?? null, candidate.error ?? null,
    );
  }

  private importLegacy(): void {
    const source = resolve(this.dataDir, "intelligence-candidates.json");
    this.state.importJsonFile<IntelligenceCandidate>(
      source,
      (value) => {
        if (!Array.isArray(value)) throw new Error("expected candidate array");
        return value as IntelligenceCandidate[];
      },
      (candidate) => this.insert({
        ...candidate,
        domain: candidate.domain ?? "ai",
        symbols: normalizeSymbols(candidate.symbols),
        attempt_count: candidate.attempt_count ?? (candidate.status === "failed" ? 1 : 0),
        scores: {
          ...candidate.scores,
          base_total: candidate.scores.base_total ?? candidate.scores.total,
          feedback_adjustment: candidate.scores.feedback_adjustment ?? 0,
        },
      }),
    );
  }
}

function assertSafeExternalUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Candidate callback target URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Candidate callback target must use an HTTPS URL without credentials");
  }
}

const FEEDBACK_WEIGHT: Record<CandidateFeedbackSignal, number> = {
  valuable: 0.08,
  opened: 0.02,
  not_valuable: -0.08,
  too_late: -0.05,
  duplicate: 0,
};

function fromRow(row: CandidateRow): IntelligenceCandidate {
  return {
    id: row.id, domain: row.domain ?? "ai", scan_id: row.scan_id, member_id: row.member_id, event_key: row.event_key,
    headline: row.headline, brief: row.brief, url: row.url, source: row.source,
    source_id: row.source_id ?? undefined, market: row.market ?? undefined,
    symbols: parseSymbols(row.symbols_json), event_type: row.event_type ?? undefined,
    evidence_tier: row.evidence_tier ?? undefined,
    scores: {
      importance: row.importance, interest: row.interest, confidence: row.confidence,
      novelty: row.novelty, base_total: row.base_total,
      feedback_adjustment: row.feedback_adjustment, total: row.total,
    },
    rationale: row.rationale, is_update: Boolean(row.is_update), status: row.status,
    decision: row.decision, duplicate_of: row.duplicate_of ?? undefined,
    attempt_count: row.attempt_count, next_attempt_at: row.next_attempt_at ?? undefined,
    claim_token: row.claim_token ?? undefined, created_at: row.created_at, updated_at: row.updated_at,
    pushed_at: row.pushed_at ?? undefined, error: row.error ?? undefined,
  };
}

function normalizeSymbols(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))].slice(0, 20);
}

function parseSymbols(value: string | undefined): string[] {
  try { return normalizeSymbols(JSON.parse(value ?? "[]") as string[]); }
  catch { return []; }
}

function weightedScore(value: CandidateEvaluation): number {
  return Number((clamp(value.importance) * 0.35 + clamp(value.interest) * 0.3 + clamp(value.confidence) * 0.2 + clamp(value.novelty) * 0.15).toFixed(3));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampScore(value: number): number {
  return Number(clamp(value).toFixed(3));
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(3)}`;
}

function isSameEvent(candidate: IntelligenceCandidate, evaluation: CandidateEvaluation): boolean {
  if (candidate.event_key === evaluation.event_key || candidate.url === evaluation.url) return true;
  return ngramSimilarity(candidate.headline, evaluation.headline) >= 0.78;
}

function ngramSimilarity(left: string, right: string): number {
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}

function grams(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const result = new Set<string>();
  if (normalized.length < 2) return normalized ? new Set([normalized]) : result;
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
  return result;
}
