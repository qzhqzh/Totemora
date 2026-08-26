import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyInitialStateMigration: StateMigration = (db) => {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS legacy_imports (
        source_path TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, id)
      );
      CREATE INDEX IF NOT EXISTS records_namespace_updated
        ON records(namespace, updated_at DESC);
      CREATE TABLE IF NOT EXISTS intelligence_candidates (
        id TEXT PRIMARY KEY,
        scan_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        headline TEXT NOT NULL,
        brief TEXT NOT NULL,
        url TEXT NOT NULL,
        source TEXT NOT NULL,
        importance REAL NOT NULL,
        interest REAL NOT NULL,
        confidence REAL NOT NULL,
        novelty REAL NOT NULL,
        base_total REAL NOT NULL,
        feedback_adjustment REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL,
        rationale TEXT NOT NULL,
        is_update INTEGER NOT NULL,
        status TEXT NOT NULL,
        decision TEXT NOT NULL,
        duplicate_of TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        claim_token TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pushed_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS candidate_dispatch
        ON intelligence_candidates(status, next_attempt_at, total DESC, created_at);
      CREATE INDEX IF NOT EXISTS candidate_event_history
        ON intelligence_candidates(event_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS candidate_url_history
        ON intelligence_candidates(url, created_at DESC);
      CREATE TABLE IF NOT EXISTS candidate_feedback (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES intelligence_candidates(id),
        signal TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT,
        UNIQUE(candidate_id, source, signal)
      );
      CREATE INDEX IF NOT EXISTS candidate_feedback_signal
        ON candidate_feedback(signal, created_at DESC);
      CREATE TABLE IF NOT EXISTS feedback_callbacks (
        token_hash TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES intelligence_candidates(id),
        target_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        opened_at TEXT
      );
      CREATE TABLE IF NOT EXISTS action_journal (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        asset_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        action TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        evidence TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS schedule_leases (
        service_id TEXT NOT NULL,
        window_key TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        PRIMARY KEY(service_id, window_key)
      );
      CREATE TABLE IF NOT EXISTS channel_state (
        channel TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        retry_after TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS member_events (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        credit_type TEXT NOT NULL,
        credit_value REAL NOT NULL,
        verified INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        summary TEXT NOT NULL,
        at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS member_event_source
        ON member_events(member_id, source_type, source_id)
        WHERE source_id IS NOT NULL AND source_id <> '';
      CREATE INDEX IF NOT EXISTS member_event_timeline
        ON member_events(member_id, at DESC);
      CREATE TABLE IF NOT EXISTS member_constitutions (
        member_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        proposal_id TEXT,
        PRIMARY KEY(member_id, version)
      );
      CREATE TABLE IF NOT EXISTS evolution_proposals (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_evolution
        ON evolution_proposals(member_id)
        WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS specialist_tasks (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        service_version INTEGER NOT NULL,
        operation TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        member_id TEXT,
        chief_member_id TEXT,
        idempotency_key TEXT,
        input_json TEXT NOT NULL,
        result_json TEXT,
        result_ref TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(service_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS specialist_task_status
        ON specialist_tasks(service_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS service_bindings (
        service_id TEXT PRIMARY KEY,
        service_version INTEGER NOT NULL,
        chief_member_id TEXT NOT NULL,
        specialist_member_id TEXT NOT NULL,
        routing_reason TEXT NOT NULL,
        capability_evidence_json TEXT NOT NULL,
        tool_grants_json TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS specialist_task_events (
        task_id TEXT NOT NULL REFERENCES specialist_tasks(id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor_id TEXT,
        stage TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_json TEXT,
        at TEXT NOT NULL,
        PRIMARY KEY(task_id, seq)
      );
    `);
    if (!hasMigration(db, 1)) recordMigration(db, 1, "initial durable tribe state");
  })();
};
