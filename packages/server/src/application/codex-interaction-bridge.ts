import type {
  CodexAppServerClient,
  CodexServerRequest,
  JsonObject,
} from "../integrations/codex-app-server-client";
import type {
  CodexInteraction,
  CodexInteractionOption,
} from "../domains/codex/codex-supervisor-types";
import { CodexInteractionRepository } from "../repositories/codex-interaction-repository";
import { CodexThreadRepository } from "../repositories/codex-thread-repository";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export class CodexInteractionBridge {
  private readonly interactions: CodexInteractionRepository;
  private readonly threads: CodexThreadRepository;

  constructor(dataDir: string) {
    this.interactions = new CodexInteractionRepository(dataDir);
    this.threads = new CodexThreadRepository(dataDir);
  }

  handleServerRequest(request: CodexServerRequest, connectionId: string, client: CodexAppServerClient): void {
    const params = objectValue(request.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const thread = threadId ? this.threads.get(threadId) : undefined;
    if (!thread || thread.mode !== "managed") {
      this.declineUnmanaged(request, client);
      return;
    }
    if (APPROVAL_METHODS.has(request.method)) {
      const interaction = this.interactions.create({
        thread_id: threadId!,
        kind: "approval",
        title: approvalTitle(request.method),
        body: approvalBody(request.method, params),
        options: approvalOptions(request.method),
        recommendation_option_id: "decline",
        source: "app_server",
        server_method: request.method,
        server_request_id: request.id,
        connection_id: connectionId,
        params: approvalStorageParams(request.method, params),
      });
      this.setWaitingPhase(threadId!, "waiting_approval", interaction.id);
      return;
    }
    if (request.method === "tool/requestUserInput") {
      if (hasSecretQuestion(params)) {
        client.respondError(request.id, -32003, "Totemora does not bridge secret input fields");
        return;
      }
      const presentation = questionPresentation(params);
      const interaction = this.interactions.create({
        thread_id: threadId!,
        kind: "decision",
        ...presentation,
        source: "app_server",
        server_method: request.method,
        server_request_id: request.id,
        connection_id: connectionId,
        params: boundedQuestions(params),
      });
      this.setWaitingPhase(threadId!, "waiting_decision", interaction.id);
      return;
    }
    client.respondError(request.id, -32601, "Totemora does not support this App Server request");
  }

  answerServerInteraction(input: {
    id: string;
    expected_revision: number;
    selected_option_id?: string;
    response_text?: string;
  }, connectionId: string, client: CodexAppServerClient): CodexInteraction {
    const current = this.interactions.get(input.id);
    if (!current?.server_request_id || !current.server_method) throw new Error("Interaction is not an App Server request");
    if (current.connection_id !== connectionId) {
      this.interactions.markManualAttention(current.id);
      throw new Error("App Server request ownership was lost; manual attention is required");
    }
    const answered = this.interactions.answer(input);
    try {
      this.sendAnswer(answered, client);
      return this.interactions.resolve(answered.id, answered.revision);
    } catch (error) {
      this.interactions.markManualAttention(answered.id);
      throw error;
    }
  }

  private sendAnswer(interaction: CodexInteraction, client: CodexAppServerClient): void {
    const requestId = interaction.server_request_id!;
    const selected = interaction.selected_option_id;
    if (interaction.server_method === "item/permissions/requestApproval") {
      if (selected === "accept_turn") {
        const params = objectValue(interaction.params);
        client.respond(requestId, { permissions: params.permissions ?? {}, scope: "turn" });
      } else {
        client.respondError(requestId, -32001, "Operator declined the permission request");
      }
      return;
    }
    if (APPROVAL_METHODS.has(interaction.server_method!)) {
      if (!selected || !["accept", "decline", "cancel"].includes(selected)) throw new Error("Invalid approval decision");
      client.respond(requestId, { decision: selected });
      return;
    }
    if (interaction.server_method === "tool/requestUserInput") {
      if (selected === "pause") {
        client.respondError(requestId, -32002, "Operator paused instead of answering");
      } else {
        client.respond(requestId, { answers: buildQuestionAnswers(interaction) });
      }
      return;
    }
    throw new Error("Unsupported App Server interaction method");
  }

  private declineUnmanaged(request: CodexServerRequest, client: CodexAppServerClient): void {
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      client.respond(request.id, { decision: "decline" });
    } else {
      client.respondError(request.id, -32001, "Totemora only handles requests for explicitly managed threads");
    }
  }

  private setWaitingPhase(threadId: string, phase: "waiting_approval" | "waiting_decision", interactionId: string): void {
    const thread = this.threads.getRequired(threadId);
    this.threads.updateControl(threadId, thread.revision, {
      phase,
      last_error: `Waiting for operator interaction ${interactionId}`,
    });
  }
}

function approvalTitle(method: string): string {
  if (method.includes("commandExecution")) return "Codex requests command approval";
  if (method.includes("fileChange")) return "Codex requests file-change approval";
  return "Codex requests additional permissions";
}

function approvalBody(method: string, params: JsonObject): string {
  if (method.includes("commandExecution")) {
    return redact(String(params.command ?? params.reason ?? "Command details were not provided")).slice(0, 8_000);
  }
  if (method.includes("fileChange")) {
    return redact(`Reason: ${String(params.reason ?? "not provided")}\nGrant root: ${String(params.grantRoot ?? "not requested")}`);
  }
  return redact(`Requested permissions: ${safeJson(params.permissions)}`).slice(0, 8_000);
}

function approvalOptions(method: string): CodexInteractionOption[] {
  if (method === "item/permissions/requestApproval") {
    return [
      { id: "accept_turn", label: "Allow this turn", description: "Grant only the requested permissions for the current turn." },
      { id: "decline", label: "Decline", description: "Do not grant the requested permissions." },
    ];
  }
  return [
    { id: "accept", label: "Accept once", description: "Allow only this concrete action." },
    { id: "decline", label: "Decline", description: "Deny the action and let the turn continue." },
    { id: "cancel", label: "Cancel turn", description: "Deny the action and interrupt this turn." },
  ];
}

function approvalStorageParams(method: string, params: JsonObject): JsonObject {
  return method === "item/permissions/requestApproval" ? { permissions: params.permissions ?? {} } : {};
}

function questionPresentation(params: JsonObject): {
  title: string;
  body: string;
  options: CodexInteractionOption[];
  recommendation_option_id?: string;
} {
  const questions = Array.isArray(params.questions) ? params.questions.map(objectValue) : [];
  const question = questions.length === 1 ? questions[0] : undefined;
  const options = question && Array.isArray(question.options) ? question.options.map(objectValue) : [];
  if (question && options.length >= 2 && options.length <= 3) {
    return {
      title: String(question.header ?? "Codex needs a decision").slice(0, 200),
      body: String(question.question ?? "Choose an option").slice(0, 10_000),
      options: options.map((option, index) => ({
        id: `choice-${index}`,
        label: String(option.label ?? `Option ${index + 1}`).slice(0, 200),
        description: String(option.description ?? "").slice(0, 1_000),
      })),
    };
  }
  return {
    title: "Codex needs structured input",
    body: questions.map((item) => `${String(item.header ?? "Question")}: ${String(item.question ?? "")}`).join("\n").slice(0, 10_000),
    options: [
      { id: "provide_answers", label: "Provide answers", description: "Enter a JSON object keyed by question id." },
      { id: "pause", label: "Pause", description: "Leave the questions unanswered and pause this turn." },
    ],
  };
}

function buildQuestionAnswers(interaction: CodexInteraction): JsonObject {
  const params = objectValue(interaction.params);
  const questions = Array.isArray(params.questions) ? params.questions.map(objectValue) : [];
  if (questions.length === 1 && interaction.selected_option_id?.startsWith("choice-")) {
    const questionId = String(questions[0]!.id ?? "question");
    const selected = interaction.options.find((option) => option.id === interaction.selected_option_id)!;
    return { [questionId]: { answers: [selected.label] } };
  }
  const parsed = JSON.parse(interaction.response_text ?? "{}") as unknown;
  const values = objectValue(parsed);
  const answers: JsonObject = {};
  for (const question of questions) {
    const id = String(question.id ?? "");
    const value = values[id];
    const list = Array.isArray(value) ? value : [value];
    if (!id || list.some((item) => typeof item !== "string")) throw new Error("Structured answers must map question ids to strings");
    answers[id] = { answers: list.map(String) };
  }
  return answers;
}

function boundedQuestions(params: JsonObject): JsonObject {
  const questions = Array.isArray(params.questions) ? params.questions.slice(0, 3).map((item) => {
    const question = objectValue(item);
    return {
      id: String(question.id ?? "question").slice(0, 200),
      header: String(question.header ?? "Question").slice(0, 200),
      question: String(question.question ?? "").slice(0, 5_000),
      options: Array.isArray(question.options) ? question.options.slice(0, 3).map((option) => {
        const value = objectValue(option);
        return {
          label: String(value.label ?? "Option").slice(0, 200),
          description: String(value.description ?? "").slice(0, 1_000),
        };
      }) : [],
    };
  }) : [];
  return { questions };
}

function hasSecretQuestion(params: JsonObject): boolean {
  return Array.isArray(params.questions) && params.questions.some((item) => objectValue(item).isSecret === true);
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "{}"; }
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]");
}
