import { StateDatabase } from "../state-database";
import type {
  CodexInteraction,
  CodexInteractionKind,
  CodexInteractionOption,
} from "../domains/codex/codex-supervisor-types";

interface InteractionRow extends Omit<
  CodexInteraction,
  "options" | "recommendation_option_id" | "default_option_id" | "selected_option_id"
  | "response_text" | "server_method" | "server_request_id" | "connection_id" | "params"
  | "expires_at" | "resolved_at"
> {
  options_json: string;
  recommendation_option_id: string | null;
  default_option_id: string | null;
  selected_option_id: string | null;
  response_text: string | null;
  server_method: string | null;
  server_request_id: string | null;
  connection_id: string | null;
  params_json: string | null;
  expires_at: string | null;
  resolved_at: string | null;
}

export class CodexInteractionRepository {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  create(input: {
    thread_id: string;
    kind: CodexInteractionKind;
    title: string;
    body: string;
    options?: CodexInteractionOption[];
    recommendation_option_id?: string;
    default_option_id?: string;
    source: CodexInteraction["source"];
    server_method?: string;
    server_request_id?: string | number;
    connection_id?: string;
    params?: unknown;
    expires_at?: string;
  }): CodexInteraction {
    const normalized = validateInput(input);
    if (input.server_request_id !== undefined && input.connection_id) {
      const existing = this.byServerRequest(input.connection_id, input.server_request_id);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.state.db.query(`
      INSERT INTO codex_interactions(
        id,thread_id,kind,status,title,body,options_json,recommendation_option_id,
        default_option_id,source,server_method,server_request_id,connection_id,params_json,
        expires_at,created_at,updated_at
      ) VALUES(?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, input.thread_id, input.kind, normalized.title, normalized.body,
      JSON.stringify(normalized.options), input.recommendation_option_id ?? null,
      input.default_option_id ?? null, input.source, input.server_method ?? null,
      input.server_request_id === undefined ? null : JSON.stringify(input.server_request_id),
      input.connection_id ?? null, input.params === undefined ? null : JSON.stringify(input.params),
      input.expires_at ?? null, now, now,
    );
    return this.getRequired(id);
  }

  answer(input: {
    id: string;
    expected_revision: number;
    selected_option_id?: string;
    response_text?: string;
  }): CodexInteraction {
    const interaction = this.getRequired(input.id);
    if (interaction.status !== "open") throw new Error(`Codex interaction is not open: ${input.id}`);
    const selected = input.selected_option_id?.trim() || undefined;
    const response = input.response_text?.trim() || undefined;
    if (interaction.options.length && !interaction.options.some((option) => option.id === selected)) {
      throw new Error("Selected Codex interaction option is invalid");
    }
    if (!interaction.options.length && !response) throw new Error("Codex interaction response cannot be empty");
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_interactions SET
        status='answered',selected_option_id=?,response_text=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=? AND status='open'
    `).run(selected ?? null, response ?? null, now, input.id, input.expected_revision);
    if (result.changes !== 1) throw new Error(`Codex interaction revision conflict: ${input.id}`);
    return this.getRequired(input.id);
  }

  resolve(id: string, expectedRevision: number): CodexInteraction {
    return this.setTerminalStatus(id, expectedRevision, "resolved");
  }

  cancel(id: string, expectedRevision: number): CodexInteraction {
    return this.setTerminalStatus(id, expectedRevision, "cancelled");
  }

  applyExpired(now = new Date().toISOString()): { defaulted: number; expired: number } {
    const defaulted = this.state.db.query(`
      UPDATE codex_interactions SET
        status='defaulted',selected_option_id=default_option_id,revision=revision+1,
        updated_at=?,resolved_at=?
      WHERE kind='suggest' AND status='open' AND default_option_id IS NOT NULL AND expires_at<=?
    `).run(now, now, now).changes;
    const expired = this.state.db.query(`
      UPDATE codex_interactions SET status='expired',revision=revision+1,updated_at=?,resolved_at=?
      WHERE status='open' AND expires_at IS NOT NULL AND expires_at<=?
    `).run(now, now, now).changes;
    return { defaulted, expired };
  }

  markConnectionLost(connectionId: string): number {
    const now = new Date().toISOString();
    return this.state.db.query(`
      UPDATE codex_interactions SET
        status='manual_attention',revision=revision+1,updated_at=?,resolved_at=?
      WHERE connection_id=? AND server_request_id IS NOT NULL AND status IN ('open','answered')
    `).run(now, now, connectionId).changes;
  }

  markManualAttention(id: string): CodexInteraction {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_interactions SET status='manual_attention',revision=revision+1,updated_at=?,resolved_at=?
      WHERE id=? AND status IN ('open','answered')
    `).run(now, now, id);
    if (result.changes !== 1) throw new Error(`Codex interaction cannot enter manual attention: ${id}`);
    return this.getRequired(id);
  }

  get(id: string): CodexInteraction | undefined {
    const row = this.state.db.query("SELECT * FROM codex_interactions WHERE id=?").get(id) as InteractionRow | null;
    return row ? fromRow(row) : undefined;
  }

  list(input: { thread_id?: string; status?: CodexInteraction["status"]; limit?: number } = {}): CodexInteraction[] {
    const filters: string[] = [];
    const parameters: string[] = [];
    if (input.thread_id) { filters.push("thread_id=?"); parameters.push(input.thread_id); }
    if (input.status) { filters.push("status=?"); parameters.push(input.status); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (this.state.db.query(`
      SELECT * FROM codex_interactions ${where} ORDER BY created_at DESC LIMIT ?
    `).all(...parameters, Math.max(1, Math.min(500, input.limit ?? 100))) as InteractionRow[]).map(fromRow);
  }

  countOpen(): number {
    const row = this.state.db.query("SELECT COUNT(*) AS count FROM codex_interactions WHERE status='open'").get() as { count: number };
    return row.count;
  }

  openCounts(): Partial<Record<CodexInteractionKind, number>> {
    const rows = this.state.db.query("SELECT kind,COUNT(*) AS count FROM codex_interactions WHERE status='open' GROUP BY kind")
      .all() as Array<{ kind: CodexInteractionKind; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
  }

  private byServerRequest(connectionId: string, requestId: string | number): CodexInteraction | undefined {
    const row = this.state.db.query(`
      SELECT * FROM codex_interactions WHERE connection_id=? AND server_request_id=?
    `).get(connectionId, JSON.stringify(requestId)) as InteractionRow | null;
    return row ? fromRow(row) : undefined;
  }

  private getRequired(id: string): CodexInteraction {
    const interaction = this.get(id);
    if (!interaction) throw new Error(`Codex interaction not found: ${id}`);
    return interaction;
  }

  private setTerminalStatus(id: string, expectedRevision: number, status: "resolved" | "cancelled"): CodexInteraction {
    const now = new Date().toISOString();
    const result = this.state.db.query(`
      UPDATE codex_interactions SET status=?,revision=revision+1,updated_at=?,resolved_at=?
      WHERE id=? AND revision=? AND status IN ('open','answered','defaulted')
    `).run(status, now, now, id, expectedRevision);
    if (result.changes !== 1) throw new Error(`Codex interaction revision conflict: ${id}`);
    return this.getRequired(id);
  }
}

function validateInput(input: {
  kind: CodexInteractionKind;
  title: string;
  body: string;
  options?: CodexInteractionOption[];
  recommendation_option_id?: string;
  default_option_id?: string;
}): { title: string; body: string; options: CodexInteractionOption[] } {
  const title = input.title.trim();
  const body = input.body.trim();
  const options = (input.options ?? []).map((option) => ({
    id: option.id.trim(), label: option.label.trim(), description: option.description.trim(),
  }));
  if (!title || title.length > 200 || !body || body.length > 10_000) throw new Error("Invalid Codex interaction text bounds");
  if (new Set(options.map((option) => option.id)).size !== options.length || options.some((option) => !option.id || !option.label)) {
    throw new Error("Codex interaction options must have unique non-empty ids and labels");
  }
  if (input.kind === "fyi" && options.length) throw new Error("FYI interactions cannot have options");
  if ((input.kind === "suggest" || input.kind === "decision") && (options.length < 2 || options.length > 3)) {
    throw new Error("Suggest and decision interactions require 2-3 options");
  }
  const optionIds = new Set(options.map((option) => option.id));
  if (input.recommendation_option_id && !optionIds.has(input.recommendation_option_id)) {
    throw new Error("Codex interaction recommendation is not an option");
  }
  if (input.kind === "suggest" && (!input.recommendation_option_id || !input.default_option_id)) {
    throw new Error("Suggest interactions require a recommendation and reversible default");
  }
  if (input.default_option_id && !optionIds.has(input.default_option_id)) throw new Error("Codex interaction default is not an option");
  if ((input.kind === "decision" || input.kind === "approval") && input.default_option_id) {
    throw new Error("Decision and approval interactions cannot have automatic defaults");
  }
  return { title, body, options };
}

function fromRow(row: InteractionRow): CodexInteraction {
  return {
    ...row,
    options: JSON.parse(row.options_json) as CodexInteractionOption[],
    recommendation_option_id: row.recommendation_option_id ?? undefined,
    default_option_id: row.default_option_id ?? undefined,
    selected_option_id: row.selected_option_id ?? undefined,
    response_text: row.response_text ?? undefined,
    server_method: row.server_method ?? undefined,
    server_request_id: row.server_request_id ? parseRequestId(row.server_request_id) : undefined,
    connection_id: row.connection_id ?? undefined,
    params: row.params_json ? JSON.parse(row.params_json) : undefined,
    expires_at: row.expires_at ?? undefined,
    resolved_at: row.resolved_at ?? undefined,
    options_json: undefined,
    params_json: undefined,
  } as CodexInteraction;
}

function parseRequestId(value: string): string | number {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "number" || typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}
