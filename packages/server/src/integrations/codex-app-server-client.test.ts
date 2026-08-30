import { expect, test } from "bun:test";

import {
  CODEX_THREAD_SOURCE_KINDS,
  CodexAppServerClient,
  type CodexServerRequest,
  type JsonObject,
} from "./codex-app-server-client";
import type {
  CodexAppServerTransport,
  CodexAppServerTransportOptions,
} from "./codex-app-server-transport";

test("client initializes, paginates every source kind, and forces user approval review", async () => {
  const fixture = new FakeAppServer();
  const client = new CodexAppServerClient({
    socketPath: "/ignored.sock",
    transportFactory: fixture.connect,
  });
  await client.connect();
  const threads = await client.listAllThreads();
  await client.resumeManagedThread("thread-1", { approvalsReviewer: "auto_review" });
  await client.startManagedTurn("thread-1", "continue", "directive-1");

  expect(threads.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
  expect(fixture.requests.filter((request) => request.method === "thread/list")).toHaveLength(2);
  expect(fixture.requests.find((request) => request.method === "thread/list")?.params.sourceKinds)
    .toEqual([...CODEX_THREAD_SOURCE_KINDS]);
  expect(fixture.requests.find((request) => request.method === "thread/resume")?.params.approvalsReviewer)
    .toBe("user");
  expect(fixture.requests.find((request) => request.method === "turn/start")?.params.approvalsReviewer)
    .toBe("user");
  expect(fixture.notifications).toContainEqual({ method: "initialized", params: {} });
  client.close();
});

test("client surfaces server requests and sends explicit responses", async () => {
  const fixture = new FakeAppServer();
  const requests: CodexServerRequest[] = [];
  const client = new CodexAppServerClient({
    socketPath: "/ignored.sock",
    transportFactory: fixture.connect,
    onServerRequest: (request) => requests.push(request),
  });
  await client.connect();
  fixture.deliver({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: { command: "git status" },
  });
  client.respond("approval-1", { decision: "decline" });

  expect(requests).toEqual([expect.objectContaining({ id: "approval-1" })]);
  expect(fixture.responses).toContainEqual({ id: "approval-1", result: { decision: "decline" } });
  client.close();
});

test("client rejects pending calls when the connection is lost", async () => {
  const fixture = new FakeAppServer();
  fixture.hangMethods.add("thread/read");
  const client = new CodexAppServerClient({
    socketPath: "/ignored.sock",
    transportFactory: fixture.connect,
  });
  await client.connect();
  const pending = client.readThread("thread-1");
  fixture.disconnect(new Error("socket lost"));
  await expect(pending).rejects.toThrow("socket lost");
});

interface RecordedRequest {
  id: number;
  method: string;
  params: JsonObject;
}

class FakeAppServer {
  requests: RecordedRequest[] = [];
  notifications: JsonObject[] = [];
  responses: JsonObject[] = [];
  hangMethods = new Set<string>();
  private options: CodexAppServerTransportOptions | undefined;

  connect = async (options: CodexAppServerTransportOptions): Promise<CodexAppServerTransport> => {
    this.options = options;
    return {
      send: (message) => this.receive(JSON.parse(message) as JsonObject),
      close: () => options.onClose?.(),
    };
  };

  deliver(message: JsonObject): void {
    this.options?.onMessage(JSON.stringify(message));
  }

  disconnect(error: Error): void {
    this.options?.onClose?.(error);
  }

  private receive(message: JsonObject): void {
    if (typeof message.id === "number" && typeof message.method === "string") {
      const request = { id: message.id, method: message.method, params: message.params as JsonObject };
      this.requests.push(request);
      if (!this.hangMethods.has(request.method)) queueMicrotask(() => this.reply(request));
    } else if (typeof message.method === "string") {
      this.notifications.push(message);
    } else {
      this.responses.push(message);
    }
  }

  private reply(request: RecordedRequest): void {
    if (request.method === "thread/list") {
      const cursor = request.params.cursor;
      this.deliver({
        id: request.id,
        result: cursor === null
          ? { data: [thread("thread-1")], nextCursor: "next" }
          : { data: [thread("thread-2")], nextCursor: null },
      });
      return;
    }
    if (request.method === "thread/resume") {
      this.deliver({ id: request.id, result: { thread: thread("thread-1") } });
      return;
    }
    if (request.method === "turn/start") {
      this.deliver({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
      return;
    }
    this.deliver({ id: request.id, result: {} });
  }
}

function thread(id: string): JsonObject {
  return {
    id,
    cwd: "/workspace",
    status: { type: "idle" },
    createdAt: 1,
    updatedAt: 2,
    turns: [],
  };
}
