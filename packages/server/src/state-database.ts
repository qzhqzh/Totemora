import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  GIT_FLOW_SKILL_ID,
  GIT_FLOW_SKILL_VERSION,
  LEGACY_GIT_FLOW_SKILL_ID,
  LEGACY_GIT_FLOW_SKILL_VERSION,
} from "./git-flow-skill";

const instances = new Map<string, StateDatabase>();

export interface LegacyImportResult {
  imported: boolean;
  row_count: number;
}

export class StateDatabase {
  readonly db: Database;

  static open(dataDir: string): StateDatabase {
    const path = resolve(dataDir, "totemora.db");
    let instance = instances.get(path);
    if (!instance) {
      instance = new StateDatabase(path);
      instances.set(path, instance);
    }
    return instance;
  }

  private constructor(readonly path: string) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
    const existing = this.db.query("SELECT version FROM schema_migrations WHERE version = 1").get() as { version: number } | null;
    if (!existing) {
      this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,?,?)")
        .run("initial durable tribe state", new Date().toISOString());
    }
    const intelligenceDomain = this.db.query("SELECT version FROM schema_migrations WHERE version = 2").get() as { version: number } | null;
    if (!intelligenceDomain) {
      this.db.transaction(() => {
        const columns = new Set((this.db.query("PRAGMA table_info(intelligence_candidates)").all() as Array<{ name: string }>).map((column) => column.name));
        if (!columns.has("domain")) this.db.exec("ALTER TABLE intelligence_candidates ADD COLUMN domain TEXT NOT NULL DEFAULT 'ai'");
        if (!columns.has("market")) this.db.exec("ALTER TABLE intelligence_candidates ADD COLUMN market TEXT");
        if (!columns.has("symbols_json")) this.db.exec("ALTER TABLE intelligence_candidates ADD COLUMN symbols_json TEXT NOT NULL DEFAULT '[]'");
        if (!columns.has("event_type")) this.db.exec("ALTER TABLE intelligence_candidates ADD COLUMN event_type TEXT");
        if (!columns.has("evidence_tier")) this.db.exec("ALTER TABLE intelligence_candidates ADD COLUMN evidence_tier TEXT");
        if (!columns.has("source_id")) this.db.exec("ALTER TABLE intelligence_candidates ADD COLUMN source_id TEXT");
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS candidate_domain_dispatch
            ON intelligence_candidates(domain, status, next_attempt_at, total DESC, created_at);
          CREATE INDEX IF NOT EXISTS candidate_domain_event_history
            ON intelligence_candidates(domain, event_key, created_at DESC);
        `);
        this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(2,?,?)")
          .run("domain-aware intelligence candidates", new Date().toISOString());
      })();
    }
    const skillCommission = this.db.query("SELECT version FROM schema_migrations WHERE version = 3").get() as { version: number } | null;
    if (!skillCommission) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS skill_commissions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            goal TEXT NOT NULL,
            status TEXT NOT NULL,
            chief_member_id TEXT NOT NULL,
            target_member_id TEXT,
            target_service_id TEXT,
            risk TEXT NOT NULL,
            package_json TEXT,
            package_digest TEXT,
            package_version INTEGER,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS skill_commission_status
            ON skill_commissions(status, updated_at DESC);
          CREATE TABLE IF NOT EXISTS skill_commission_messages (
            id TEXT PRIMARY KEY,
            commission_id TEXT NOT NULL REFERENCES skill_commissions(id),
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS skill_commission_message_timeline
            ON skill_commission_messages(commission_id, created_at, id);
          CREATE TABLE IF NOT EXISTS skill_trials (
            id TEXT PRIMARY KEY,
            commission_id TEXT NOT NULL REFERENCES skill_commissions(id),
            baseline_evidence_id TEXT NOT NULL,
            trial_evidence_id TEXT NOT NULL,
            reviewer_member_id TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected')),
            metrics_json TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(commission_id, trial_evidence_id)
          );
          CREATE TABLE IF NOT EXISTS skill_activations (
            id TEXT PRIMARY KEY,
            commission_id TEXT NOT NULL REFERENCES skill_commissions(id),
            skill_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            digest TEXT NOT NULL,
            target_member_id TEXT,
            target_service_id TEXT,
            package_json TEXT NOT NULL,
            status TEXT NOT NULL,
            approved_by TEXT NOT NULL,
            activated_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS skill_activation_lookup
            ON skill_activations(skill_id, status, version DESC);
        `);
        this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(3,?,?)")
          .run("conversational skill commissions", new Date().toISOString());
      })();
    }
    const skillCommissionRevision = this.db.query("SELECT version FROM schema_migrations WHERE version = 4").get() as { version: number } | null;
    if (!skillCommissionRevision) {
      this.db.transaction(() => {
        const columns = new Set((this.db.query("PRAGMA table_info(skill_commissions)").all() as Array<{ name: string }>).map((column) => column.name));
        if (!columns.has("revision")) this.db.exec("ALTER TABLE skill_commissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
        this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(4,?,?)")
          .run("skill commission optimistic concurrency", new Date().toISOString());
      })();
    }
    const skillTrialRunLease = this.db.query("SELECT version FROM schema_migrations WHERE version = 5").get() as { version: number } | null;
    if (!skillTrialRunLease) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS skill_trial_run_leases (
            commission_id TEXT PRIMARY KEY,
            run_id TEXT UNIQUE NOT NULL,
            owner_id TEXT,
            claimed_at TEXT
          )
        `);
        this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(5,?,?)")
          .run("skill trial active run reservation", new Date().toISOString());
      })();
    }
    const skillTrialLeaseFencing = this.db.query("SELECT version FROM schema_migrations WHERE version = 6").get() as { version: number } | null;
    if (!skillTrialLeaseFencing) {
      this.db.transaction(() => {
        const columns = new Set((this.db.query("PRAGMA table_info(skill_trial_run_leases)").all() as Array<{ name: string }>).map((column) => column.name));
        if (!columns.has("claim_token")) this.db.exec("ALTER TABLE skill_trial_run_leases ADD COLUMN claim_token TEXT");
        if (!columns.has("lease_expires_at")) this.db.exec("ALTER TABLE skill_trial_run_leases ADD COLUMN lease_expires_at TEXT");
        this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(6,?,?)")
          .run("skill trial lease fencing", new Date().toISOString());
      })();
    }
    const gitFlowSkillId = this.db.query("SELECT version FROM schema_migrations WHERE version = 7").get() as { version: number } | null;
    if (!gitFlowSkillId) {
      this.db.transaction(() => {
        const oldId = LEGACY_GIT_FLOW_SKILL_ID;
        const newId = GIT_FLOW_SKILL_ID;
        const migratePackage = (value: Record<string, unknown>): {
          value: Record<string, unknown>;
          superseded: boolean;
        } => {
          if (value.skill_id !== oldId) return { value, superseded: false };
          const staleBase = typeof value.base_version !== "number"
            || value.base_version < GIT_FLOW_SKILL_VERSION;
          const superseded = staleBase && ["draft", "validated", "active"].includes(String(value.status));
          const migrated: Record<string, unknown> = {
            ...value,
            skill_id: newId,
            skill_md: typeof value.skill_md === "string"
              ? value.skill_md.replace(/^name: git-change-management$/m, `name: ${newId}`)
              : value.skill_md,
            ...(superseded ? { status: "superseded" } : {}),
          };
          const normalized = { ...migrated, digest: undefined, status: undefined };
          migrated.digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
          return { value: migrated, superseded };
        };

        const commissions = this.db.query(`
          SELECT id,package_json FROM skill_commissions WHERE package_json IS NOT NULL
        `).all() as Array<{ id: string; package_json: string }>;
        for (const row of commissions) {
          const migrated = migratePackage(JSON.parse(row.package_json) as Record<string, unknown>);
          if (migrated.value.skill_id === newId) {
            this.db.query(`
              UPDATE skill_commissions SET package_json=?,package_digest=?,
                status=CASE WHEN ?=1 AND status NOT IN ('cancelled','suspended','superseded')
                  THEN 'superseded' ELSE status END
              WHERE id=?
            `).run(JSON.stringify(migrated.value), String(migrated.value.digest), migrated.superseded ? 1 : 0, row.id);
          }
        }

        const activations = this.db.query(`
          SELECT id,package_json FROM skill_activations WHERE skill_id=?
        `).all(oldId) as Array<{ id: string; package_json: string }>;
        for (const row of activations) {
          const migrated = migratePackage(JSON.parse(row.package_json) as Record<string, unknown>);
          this.db.query(`
            UPDATE skill_activations SET skill_id=?,package_json=?,digest=?,
              status=CASE WHEN ?=1 AND status='active' THEN 'superseded' ELSE status END
            WHERE id=?
          `).run(
            newId, JSON.stringify(migrated.value), String(migrated.value.digest),
            migrated.superseded ? 1 : 0, row.id,
          );
        }

        const records = this.db.query(`
          SELECT namespace,id,payload_json,created_at,updated_at FROM records
          WHERE namespace IN ('skill_overlays','skill_proposals')
        `).all() as Array<{ namespace: string; id: string; payload_json: string; created_at: string; updated_at: string }>;
        for (const row of records) {
          const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
          if (payload.skill_id !== oldId) continue;
          payload.skill_id = newId;
          if (row.namespace === "skill_overlays") {
            const additions = Array.isArray(payload.additions) ? payload.additions : [];
            const previousBase = typeof payload.base_version === "number"
              ? payload.base_version
              : LEGACY_GIT_FLOW_SKILL_VERSION;
            const previousVersion = typeof payload.version === "number"
              ? payload.version
              : previousBase + additions.length;
            const versionDelta = Math.max(0, GIT_FLOW_SKILL_VERSION - previousBase);
            payload.base_version = GIT_FLOW_SKILL_VERSION;
            payload.version = Math.max(
              GIT_FLOW_SKILL_VERSION + additions.length,
              previousVersion + versionDelta,
            );
          } else if (row.namespace === "skill_proposals" && typeof payload.base_version === "number") {
            payload.base_version += GIT_FLOW_SKILL_VERSION - LEGACY_GIT_FLOW_SKILL_VERSION;
          }
          const id = row.namespace === "skill_overlays" && row.id === oldId ? newId : row.id;
          this.db.query(`
            INSERT INTO records(namespace,id,payload_json,created_at,updated_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(namespace,id) DO UPDATE SET
              payload_json=excluded.payload_json,updated_at=excluded.updated_at
          `).run(row.namespace, id, JSON.stringify(payload), row.created_at, row.updated_at);
          if (id !== row.id) this.db.query("DELETE FROM records WHERE namespace=? AND id=?").run(row.namespace, row.id);
        }
        this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(7,?,?)")
          .run("rename git flow Skill canonical id", new Date().toISOString());
      })();
    }
    const skillTrialOutcomeConstraint = this.db.query("SELECT version FROM schema_migrations WHERE version = 8").get() as { version: number } | null;
    if (!skillTrialOutcomeConstraint) {
      this.db.transaction(() => {
        const invalidTrials = this.db.query(`
          SELECT * FROM skill_trials WHERE outcome NOT IN ('accepted','rejected')
        `).all() as Array<Record<string, unknown> & { id: string; created_at: string }>;
        for (const trial of invalidTrials) {
          const quarantined = {
            reason: "invalid_outcome_before_migration_8",
            trial,
          };
          this.db.query(`
            INSERT INTO records(namespace,id,payload_json,created_at,updated_at)
            VALUES('quarantined_skill_trials',?,?,?,?)
            ON CONFLICT(namespace,id) DO UPDATE SET
              payload_json=excluded.payload_json,updated_at=excluded.updated_at
          `).run(trial.id, JSON.stringify(quarantined), trial.created_at, new Date().toISOString());
          this.db.query("DELETE FROM skill_trials WHERE id=?").run(trial.id);
        }
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS skill_trials_valid_outcome_insert
          BEFORE INSERT ON skill_trials
          WHEN NEW.outcome NOT IN ('accepted','rejected')
          BEGIN
            SELECT RAISE(ABORT, 'invalid skill trial outcome');
          END;
          CREATE TRIGGER IF NOT EXISTS skill_trials_valid_outcome_update
          BEFORE UPDATE OF outcome ON skill_trials
          WHEN NEW.outcome NOT IN ('accepted','rejected')
          BEGIN
            SELECT RAISE(ABORT, 'invalid skill trial outcome');
          END;
        `);
        this.db.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES(8,?,?)")
          .run("constrain skill trial outcomes", new Date().toISOString());
      })();
    }
  }

  importJsonFile<T>(sourcePath: string, parse: (value: unknown) => T[], insert: (row: T) => void): LegacyImportResult {
    let bytes: Buffer;
    try {
      if (!statSync(sourcePath).isFile()) return { imported: false, row_count: 0 };
      bytes = readFileSync(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imported: false, row_count: 0 };
      throw error;
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.query("SELECT sha256,row_count FROM legacy_imports WHERE source_path = ?").get(sourcePath) as {
      sha256: string; row_count: number;
    } | null;
    if (existing) {
      if (existing.sha256 !== hash) {
        throw new Error(`Legacy state changed after SQLite cutover: ${sourcePath}`);
      }
      return { imported: false, row_count: existing.row_count };
    }
    let rows: T[];
    try {
      rows = parse(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      throw new Error(`Cannot import legacy JSON ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.db.transaction(() => {
      for (const row of rows) insert(row);
      this.db.query("INSERT INTO legacy_imports(source_path,sha256,row_count,imported_at) VALUES(?,?,?,?)")
        .run(sourcePath, hash, rows.length, new Date().toISOString());
    })();
    return { imported: true, row_count: rows.length };
  }

  putRecord(namespace: string, id: string, value: unknown, createdAt?: string, updatedAt?: string): void {
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO records(namespace,id,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(namespace,id) DO UPDATE SET
        payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `).run(namespace, id, JSON.stringify(value), createdAt ?? now, updatedAt ?? now);
  }

  listRecords<T>(namespace: string): T[] {
    return (this.db.query("SELECT payload_json FROM records WHERE namespace = ? ORDER BY updated_at DESC").all(namespace) as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json) as T);
  }
}
