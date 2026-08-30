import {
  connectCodexAppServerTransport,
  type CodexAppServerTransport,
  type CodexAppServerTransportOptions,
} from "./codex-app-server-transport";
import type { CodexHistoryMode } from "../domains/codex/codex-supervisor-types";

export const CODEX_THREAD_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"] as const;

export type JsonObject = Record<string, unknown>;
export type CodexTransportFactory = (
  options: CodexAppServerTransportOptions,
) => Promise<CodexAppServerTransport>;

export interface CodexThread {
  id: string;
  cwd: string;
  name?: string | null;
  preview?: string;
  source?: unknown;
  status: { type: "notLoaded" | "idle" | "systemError" | "active"; activeFlags?: string[] };
  historyMode?: CodexHistoryMode;
  createdAt: number;
  updatedAt: number;
  turns?: unknown[];
  [key: string]: unknown;
}

export interface CodexThreadGoal {
  objective: string | null;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  [key: string]: unknown;
}

export interface CodexServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface CodexServerNotification {
  method: string;
  params: unknown;
}

export class CodexAppServerRpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) {
    super(`Codex App Server ${method} failed${code === undefined ? "" : ` (${code})`}: ${message}`);
  }
}

export interface CodexAppServerClientOptions {
  socketPath: string;
  clientName?: string;
  requestTimeoutMs?: number;
  transportFactory?: CodexTransportFactory;
  onNotification?: (notification: CodexServerNotification) => void;
  onServerRequest?: (request: CodexServerRequest) => void;
  onDisconnect?: (error?: Error) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexAppServerClient {
  private transport: CodexAppServerTransport | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private serverVersion: string | undefined;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  async connect(): Promise<void> {
    if (this.transport) return;
    this.closed = false;
    const transportFactory = this.options.transportFactory ?? connectCodexAppServerTransport;
    this.transport = await transportFactory({
      socketPath: this.options.socketPath,
      onMessage: (message) => this.handleMessage(message),
      onClose: (error) => this.handleDisconnect(error),
    });
    try {
      const initialized = await this.request<JsonObject>("initialize", {
        clientInfo: {
          name: this.options.clientName ?? "totemora-codex-supervisor",
          title: "Totemora Codex Supervisor",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      const serverInfo = initialized.serverInfo && typeof initialized.serverInfo === "object"
        ? initialized.serverInfo as JsonObject : {};
      this.serverVersion = typeof serverInfo.version === "string" ? serverInfo.version
        : typeof initialized.userAgent === "string" ? initialized.userAgent : undefined;
      this.notify("initialized", {});
    } catch (error) {
      this.transport.close();
      this.transport = undefined;
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.transport?.close();
    this.transport = undefined;
    this.rejectPending(new Error("Codex App Server client closed"));
  }

  getServerVersion(): string | undefined { return this.serverVersion; }

  async request<T>(method: string, params: JsonObject, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<T> {
    if (!this.transport) throw new Error("Codex App Server client is not connected");
    const id = this.nextRequestId++;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    try {
      this.transport.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return result;
  }

  respond(id: string | number, result: unknown): void {
    this.sendEnvelope({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.sendEnvelope({ id, error: { code, message } });
  }

  async listAllThreads(): Promise<CodexThread[]> {
    const threads: CodexThread[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: CodexThread[]; nextCursor: string | null } = await this.request("thread/list", {
        cursor,
        limit: 100,
        sourceKinds: [...CODEX_THREAD_SOURCE_KINDS],
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: true,
      });
      if (!Array.isArray(page.data)) throw new Error("Codex App Server returned an invalid thread list");
      threads.push(...page.data.map(parseThread));
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (cursor && seenCursors.has(cursor)) throw new Error("Codex App Server repeated a thread list cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return threads;
  }

  async readThread(threadId: string, includeTurns = false): Promise<CodexThread> {
    const result = await this.request<{ thread: CodexThread }>("thread/read", { threadId, includeTurns });
    return parseThread(result.thread);
  }

  async resumeManagedThread(threadId: string, overrides: JsonObject = {}): Promise<CodexThread> {
    const result = await this.request<{ thread: CodexThread }>("thread/resume", {
      ...overrides,
      threadId,
      approvalsReviewer: "user",
    });
    return parseThread(result.thread);
  }

  async getGoal(threadId: string): Promise<CodexThreadGoal | null> {
    const result = await this.request<{ goal: CodexThreadGoal | null }>("thread/goal/get", { threadId });
    return result.goal === null ? null : parseGoal(result.goal);
  }

  async setGoal(threadId: string, goal: Partial<CodexThreadGoal>): Promise<CodexThreadGoal> {
    const result = await this.request<{ goal: CodexThreadGoal }>("thread/goal/set", { threadId, ...goal });
    return parseGoal(result.goal);
  }

  async startManagedTurn(threadId: string, text: string, clientUserMessageId: string): Promise<JsonObject> {
    return this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      clientUserMessageId,
      approvalsReviewer: "user",
    });
  }

  async steerTurn(threadId: string, turnId: string, text: string, clientUserMessageId: string): Promise<JsonObject> {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text, text_elements: [] }],
      clientUserMessageId,
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<JsonObject> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  private notify(method: string, params: JsonObject): void {
    this.sendEnvelope({ method, params });
  }

  private sendEnvelope(envelope: JsonObject): void {
    if (!this.transport) throw new Error("Codex App Server client is not connected");
    this.transport.send(JSON.stringify(envelope));
  }

  private handleMessage(raw: string): void {
    try {
      const message = parseObject(JSON.parse(raw));
      if (typeof message.id === "number" && ("result" in message || "error" in message) && !message.method) {
        this.handleResponse(message.id, message);
      } else if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
        this.options.onServerRequest?.({ id: message.id, method: message.method, params: message.params });
      } else if (typeof message.method === "string") {
        this.options.onNotification?.({ method: message.method, params: message.params });
      } else {
        throw new Error("unrecognized JSON-RPC envelope");
      }
    } catch (error) {
      this.handleDisconnect(new Error(`Invalid Codex App Server message: ${error instanceof Error ? error.message : String(error)}`));
      this.transport?.close();
    }
  }

  private handleResponse(id: number, message: JsonObject): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if ("error" in message) pending.reject(toRpcError(pending.method, message.error));
    else pending.resolve(message.result);
  }

  private handleDisconnect(error?: Error): void {
    if (!this.transport && this.closed) return;
    this.transport = undefined;
    this.rejectPending(error ?? new Error("Codex App Server disconnected"));
    this.options.onDisconnect?.(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function parseObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as JsonObject;
}

function parseThread(value: unknown): CodexThread {
  const thread = parseObject(value) as Partial<CodexThread>;
  if (typeof thread.id !== "string" || typeof thread.cwd !== "string" || !thread.status || typeof thread.status.type !== "string") {
    throw new Error("Codex App Server returned an invalid thread");
  }
  if (thread.historyMode !== undefined && thread.historyMode !== "legacy" && thread.historyMode !== "paginated") {
    throw new Error("Codex App Server returned an invalid thread history mode");
  }
  return thread as CodexThread;
}

function parseGoal(value: unknown): CodexThreadGoal {
  const goal = parseObject(value) as Partial<CodexThreadGoal>;
  if (typeof goal.status !== "string" || !(typeof goal.objective === "string" || goal.objective === null)) {
    throw new Error("Codex App Server returned an invalid thread goal");
  }
  return goal as CodexThreadGoal;
}

function toRpcError(method: string, value: unknown): Error {
  const error = value && typeof value === "object" ? value as JsonObject : {};
  const message = typeof error.message === "string" ? error.message : JSON.stringify(value);
  const code = typeof error.code === "number" ? error.code : undefined;
  return new CodexAppServerRpcError(method, code, message);
}
