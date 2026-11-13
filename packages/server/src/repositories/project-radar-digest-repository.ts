import type { NotificationEnvelopeV1 } from "../domains/notification/notification-envelope";
import { StateDatabase } from "../state-database";

export type ProjectRadarDigestStatus = "sending" | "completed" | "failed" | "uncertain" | "empty";
export interface ProjectRadarDigestItem {
  action_id?: string;
  next_step?: string;
  candidate_id: string;
  evaluation_id: string;
  headline: string;
  brief: string;
  url: string;
  project_names: string[];
  reason: string;
}
export interface ProjectRadarDigestSnapshot {
  date: string;
  title: string;
  body: string;
  items: ProjectRadarDigestItem[];
  settings_fingerprint: string;
  settings_updated_at: string;
  envelope?: NotificationEnvelopeV1;
}
export interface ProjectRadarDigestRecord extends ProjectRadarDigestSnapshot {
  status: ProjectRadarDigestStatus;
  attempts: number;
  lease_token?: string;
  lease_expires_at?: string;
  last_error?: string;
  retry_after?: string;
}
interface DigestRow {
  payload_json: string; status: ProjectRadarDigestStatus; attempts: number;
  lease_token: string | null; lease_expires_at: string | null; last_error: string | null; retry_after: string | null;
}
const LEASE_MS = 5 * 60_000;

export class ProjectRadarDigestRepository {
  private readonly state: StateDatabase;
  constructor(dataDir: string) { this.state = StateDatabase.open(dataDir); }

  get(day: string): ProjectRadarDigestRecord | undefined {
    const row = this.state.db.query("SELECT * FROM project_radar_digests WHERE day=?").get(day) as DigestRow | null;
    return row ? decode(row) : undefined;
  }
  isClaimed(candidateId: string): boolean {
    return Boolean(this.state.db.query("SELECT 1 FROM project_radar_digest_items WHERE candidate_id=?").get(candidateId));
  }
  hasPriorDelivery(input: { id: string; event_key: string; url: string }): boolean {
    return Boolean(this.state.db.query(`SELECT 1 FROM intelligence_candidates c WHERE c.domain='ai' AND c.id!=?
      AND (c.event_key=? OR c.url=?) AND (c.status IN ('pushing','pushed','delivery_unknown')
      OR EXISTS(SELECT 1 FROM project_radar_digest_items i WHERE i.candidate_id=c.id)) LIMIT 1`)
      .get(input.id, input.event_key, input.url));
  }
  claim(snapshot: ProjectRadarDigestSnapshot, now = new Date()): ProjectRadarDigestRecord | undefined {
    validateSnapshot(snapshot);
    const nowText = now.toISOString();
    return this.state.db.transaction(() => {
      this.recoverStale(now);
      const settings = this.state.db.query("SELECT mode,updated_at FROM project_radar_settings WHERE id=1")
        .get() as { mode: string; updated_at: string } | null;
      if (settings?.mode !== "active" || settings.updated_at !== snapshot.settings_updated_at) return undefined;
      const existing = this.get(snapshot.date);
      if (existing && (existing.status !== "failed" || existing.attempts >= 3 || !existing.retry_after
        || existing.retry_after > nowText || existing.settings_fingerprint !== snapshot.settings_fingerprint
        || existing.settings_updated_at !== snapshot.settings_updated_at)) return undefined;
      const payload = existing ? stripRecord(existing) : snapshot;
      const previous = new Map<string, string>();
      for (const item of payload.items) {
        const row = this.state.db.query(`SELECT status,domain,duplicate_of,pushed_at,claim_token FROM intelligence_candidates WHERE id=?`)
          .get(item.candidate_id) as { status: string; domain: string; duplicate_of: string | null; pushed_at: string | null; claim_token: string | null } | null;
        if (!row || row.domain !== "ai" || row.duplicate_of || row.pushed_at || row.claim_token
          || !(existing ? row.status === "failed" : ["queued", "retry_wait", "channel_blocked"].includes(row.status))) return undefined;
        if (!existing && this.state.db.query("SELECT 1 FROM project_radar_digest_items WHERE candidate_id=?").get(item.candidate_id)) return undefined;
        previous.set(item.candidate_id, row.status);
      }
      const status = payload.items.length ? "sending" : "empty";
      const token = status === "sending" ? crypto.randomUUID() : null;
      const expires = token ? new Date(now.getTime() + LEASE_MS).toISOString() : null;
      if (existing) {
        this.state.db.query(`UPDATE project_radar_digests SET status='sending',attempts=attempts+1,
          lease_token=?,lease_expires_at=?,last_error=NULL,retry_after=NULL,updated_at=? WHERE day=?`)
          .run(token, expires, nowText, snapshot.date);
      } else {
        this.state.db.query(`INSERT INTO project_radar_digests(day,status,attempts,lease_token,lease_expires_at,payload_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(snapshot.date, status, token ? 1 : 0, token, expires, JSON.stringify(payload), nowText, nowText);
        for (const item of payload.items) this.state.db.query(`INSERT INTO project_radar_digest_items(candidate_id,digest_day,previous_status) VALUES(?,?,?)`)
          .run(item.candidate_id, snapshot.date, previous.get(item.candidate_id)!);
      }
      for (const item of payload.items) this.state.db.query(`UPDATE intelligence_candidates SET status='pushing',claim_token=?,claimed_at=?,
        attempt_count=attempt_count+1,updated_at=?,error=NULL,next_attempt_at=NULL WHERE id=?`)
        .run(token, nowText, nowText, item.candidate_id);
      return this.get(snapshot.date);
    }).immediate();
  }
  finish(day: string, token: string, outcome: "completed" | "failed" | "uncertain", now = new Date()): boolean {
    if (!["completed", "failed", "uncertain"].includes(outcome)) throw new Error("Invalid project radar digest outcome");
    return this.state.db.transaction(() => {
      this.recoverStale(now);
      const row = this.get(day);
      if (!row || row.status !== "sending" || row.lease_token !== token) return false;
      const owned = this.state.db.query(`SELECT COUNT(*) count FROM intelligence_candidates WHERE status='pushing' AND claim_token=?
        AND id IN (SELECT candidate_id FROM project_radar_digest_items WHERE digest_day=?)`).get(token, day) as { count: number };
      if (owned.count !== row.items.length) outcome = "uncertain";
      const nowText = now.toISOString();
      const retry = outcome === "failed" && row.attempts < 3 ? new Date(now.getTime() + LEASE_MS).toISOString() : null;
      const error = outcome === "completed" ? null : `project_radar_digest_${outcome}`;
      this.state.db.query(`UPDATE project_radar_digests SET status=?,lease_token=NULL,lease_expires_at=NULL,
        last_error=?,retry_after=?,updated_at=? WHERE day=? AND lease_token=?`).run(outcome, error, retry, nowText, day, token);
      this.state.db.query(`UPDATE intelligence_candidates SET status=?,pushed_at=CASE WHEN ?='completed' THEN ? ELSE pushed_at END,
        updated_at=?,error=?,claim_token=NULL,next_attempt_at=NULL WHERE claim_token=?
        AND id IN (SELECT candidate_id FROM project_radar_digest_items WHERE digest_day=?)`)
        .run(outcome === "completed" ? "pushed" : outcome === "uncertain" ? "delivery_unknown" : "failed", outcome, nowText, nowText, error, token, day);
      return true;
    }).immediate();
  }
  recoverStale(now = new Date()): number {
    return this.state.db.transaction(() => {
      const nowText = now.toISOString();
      this.state.db.query(`UPDATE intelligence_candidates SET status='delivery_unknown',claim_token=NULL,
        error='project_radar_digest_uncertain',updated_at=? WHERE status='pushing' AND claim_token IN
        (SELECT lease_token FROM project_radar_digests WHERE status='sending' AND lease_expires_at<=?)`).run(nowText, nowText);
      return this.state.db.query(`UPDATE project_radar_digests SET status='uncertain',lease_token=NULL,lease_expires_at=NULL,
        last_error='project_radar_digest_uncertain',updated_at=? WHERE status='sending' AND lease_expires_at<=?`).run(nowText, nowText).changes;
    })();
  }
  claimEvaluationWindow(window: string): boolean {
    if (!window || window.length > 64 || /[\x00-\x20\x7f]/.test(window)) throw new Error("Invalid evaluation window");
    return this.state.db.query(`UPDATE project_radar_runtime SET last_evaluation_window=?
      WHERE id=1 AND (last_evaluation_window IS NULL OR last_evaluation_window<?)`).run(window, window).changes === 1;
  }
  setFallbackUntil(timestamp: string | null): void {
    if (timestamp !== null && !Number.isFinite(Date.parse(timestamp))) throw new Error("Invalid fallback timestamp");
    this.state.db.query("UPDATE project_radar_runtime SET fallback_until=? WHERE id=1")
      .run(timestamp === null ? null : new Date(timestamp).toISOString());
  }
  getFallbackUntil(): string | undefined {
    return (this.state.db.query("SELECT fallback_until FROM project_radar_runtime WHERE id=1").get() as { fallback_until: string | null }).fallback_until ?? undefined;
  }
}

function stripRecord(row: ProjectRadarDigestRecord): ProjectRadarDigestSnapshot {
  const { status: _status, attempts: _attempts, lease_token: _token, lease_expires_at: _expires, last_error: _error, retry_after: _retry, ...snapshot } = row;
  return snapshot;
}
function decode(row: DigestRow): ProjectRadarDigestRecord {
  return { ...JSON.parse(row.payload_json) as ProjectRadarDigestSnapshot, status: row.status, attempts: row.attempts,
    ...(row.lease_token ? { lease_token: row.lease_token } : {}), ...(row.lease_expires_at ? { lease_expires_at: row.lease_expires_at } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}), ...(row.retry_after ? { retry_after: row.retry_after } : {}) };
}
function validateSnapshot(value: ProjectRadarDigestSnapshot): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(Date.parse(value.settings_updated_at))
    || !/^[a-f0-9]{64}$/.test(value.settings_fingerprint) || value.items.length > 5
    || new Set(value.items.map((item) => item.candidate_id)).size !== value.items.length
    || Buffer.byteLength(value.body) > 3_200 || Buffer.byteLength(JSON.stringify(value)) > 65_536
    || (value.items.length > 0 && (!value.envelope || value.envelope.body !== value.body
      || value.envelope.idempotency_key !== `project-radar:${value.date}`))) throw new Error("Invalid project radar digest snapshot");
}
