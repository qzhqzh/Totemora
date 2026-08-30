import type { StateMigration } from "./migration";
import { hasMigration, recordMigration } from "./migration";

export const applyCodexSupervisorMigration: StateMigration = (db) => {
  if (hasMigration(db, 9)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE codex_threads(
        thread_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        workplace_id TEXT,
        title TEXT,
        preview TEXT NOT NULL DEFAULT '',
        source_json TEXT NOT NULL DEFAULT '{}',
        app_status TEXT NOT NULL,
        app_updated_at INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'observed' CHECK(mode IN ('observed','managed')),
        phase TEXT NOT NULL DEFAULT 'observed' CHECK(phase IN (
          'observed','aligning','executing','waiting_decision','waiting_approval',
          'retry_wait','verifying','paused','completed','failed'
        )),
        goal_objective TEXT,
        goal_status TEXT,
        token_budget INTEGER,
        token_used INTEGER NOT NULL DEFAULT 0 CHECK(token_used >= 0),
        deadline_at TEXT,
        turn_timeout_at TEXT,
        current_turn_id TEXT,
        last_turn_status TEXT,
        infra_retries INTEGER NOT NULL DEFAULT 0 CHECK(infra_retries >= 0),
        strategy_attempts INTEGER NOT NULL DEFAULT 0 CHECK(strategy_attempts >= 0),
        next_action_at TEXT,
        last_directive_at TEXT,
        last_observed_at TEXT NOT NULL,
        managed_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX codex_threads_mode_phase_idx ON codex_threads(mode,phase,updated_at);
      CREATE INDEX codex_threads_workplace_idx ON codex_threads(workplace_id,phase);

      CREATE TABLE codex_directives(
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('continue','steer','answer','checkpoint','verify')),
        content TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('supervisor','web','mcp','telegram')),
        target_turn_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued','leased','completed','failed','cancelled','uncertain')),
        idempotency_key TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        lease_token TEXT,
        lease_expires_at TEXT,
        available_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX codex_directives_queue_idx ON codex_directives(status,available_at,created_at);
      CREATE INDEX codex_directives_thread_idx ON codex_directives(thread_id,status,created_at);

      CREATE TABLE codex_interactions(
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('fyi','suggest','decision','approval')),
        status TEXT NOT NULL CHECK(status IN (
          'open','answered','defaulted','expired','resolved','cancelled','manual_attention'
        )),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        recommendation_option_id TEXT,
        default_option_id TEXT,
        selected_option_id TEXT,
        response_text TEXT,
        source TEXT NOT NULL CHECK(source IN ('agent','app_server','supervisor','operator')),
        server_method TEXT,
        server_request_id TEXT,
        connection_id TEXT,
        params_json TEXT,
        expires_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE UNIQUE INDEX codex_interactions_server_request_idx
        ON codex_interactions(connection_id,server_request_id)
        WHERE server_request_id IS NOT NULL;
      CREATE INDEX codex_interactions_inbox_idx ON codex_interactions(status,kind,created_at);
      CREATE INDEX codex_interactions_thread_idx ON codex_interactions(thread_id,status,created_at);

      CREATE TABLE codex_leases(
        resource_type TEXT NOT NULL CHECK(resource_type IN ('thread','worktree')),
        resource_key TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1),
        expires_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(resource_type,resource_key)
      );
      CREATE INDEX codex_leases_thread_idx ON codex_leases(thread_id,expires_at);

      CREATE TABLE codex_agent_capabilities(
        token_hash TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX codex_agent_capabilities_thread_idx ON codex_agent_capabilities(thread_id,turn_id,expires_at);
    `);
    recordMigration(db, 9, "durable Codex session supervision");
  })();
};
