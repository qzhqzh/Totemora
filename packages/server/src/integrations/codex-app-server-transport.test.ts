import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectCodexAppServerTransport } from "./codex-app-server-transport";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

test("Unix WebSocket transport exchanges framed JSON and answers ping", async () => {
  const fixture = await createFixture((socket, request) => {
    acceptUpgrade(socket, request, Buffer.concat([
      serverFrame(0x1, Buffer.from("{\"hel"), false),
      serverFrame(0x9, Buffer.from("health")),
      serverFrame(0x0, Buffer.from("lo\":true}")),
    ]));
  });
  const messages: string[] = [];
  try {
    const transport = await connectCodexAppServerTransport({
      socketPath: fixture.socketPath,
      onMessage: (message) => messages.push(message),
    });
    transport.send(JSON.stringify({ method: "thread/list" }));
    await waitFor(() => fixture.frames.length >= 2);

    expect(messages).toEqual(["{\"hello\":true}"]);
    expect(fixture.frames).toEqual([
      { opcode: 0xA, masked: true, payload: "health" },
      { opcode: 0x1, masked: true, payload: "{\"method\":\"thread/list\"}" },
    ]);
    transport.close();
  } finally {
    await fixture.close();
  }
});

test("Unix WebSocket transport rejects an invalid accept key", async () => {
  const fixture = await createFixture((socket) => {
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Accept: invalid",
      "\r\n",
    ].join("\r\n"));
  });
  try {
    await expect(connectCodexAppServerTransport({
      socketPath: fixture.socketPath,
      onMessage: () => undefined,
    })).rejects.toThrow("invalid WebSocket accept key");
  } finally {
    await fixture.close();
  }
});

test("Unix WebSocket transport fails closed on oversized messages", async () => {
  let transportError: Error | undefined;
  const fixture = await createFixture((socket, request) => {
    acceptUpgrade(socket, request, serverFrame(0x1, Buffer.from("too large")));
  });
  try {
    await connectCodexAppServerTransport({
      socketPath: fixture.socketPath,
      maxMessageBytes: 4,
      onMessage: () => undefined,
      onClose: (error) => { transportError = error; },
    });
    await waitFor(() => transportError !== undefined);
    expect(transportError?.message).toContain("exceeds configured limit");
  } finally {
    await fixture.close();
  }
});

interface ClientFrame {
  opcode: number;
  masked: boolean;
  payload: string;
}

async function createFixture(
  onRequest: (socket: Socket, request: string) => void,
): Promise<{ socketPath: string; frames: ClientFrame[]; close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "totemora-codex-ws-"));
  const socketPath = join(directory, "app-server.sock");
  const sockets = new Set<Socket>();
  const frames: ClientFrame[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        upgraded = true;
        onRequest(socket, buffer.subarray(0, boundary).toString("utf8"));
        buffer = buffer.subarray(boundary + 4);
      }
      while (upgraded) {
        const parsed = parseClientFrame(buffer);
        if (!parsed) break;
        frames.push(parsed.frame);
        buffer = buffer.subarray(parsed.bytes);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    frames,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function acceptUpgrade(socket: Socket, request: string, frames?: Buffer): void {
  const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1]?.trim();
  if (!key) throw new Error("fixture did not receive a WebSocket key");
  const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  const response = Buffer.from([
    "HTTP/1.1 101 Switching Protocols",
    "Connection: keep-alive, Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n"));
  socket.write(frames ? Buffer.concat([response, frames]) : response);
}

function serverFrame(opcode: number, payload: Buffer, final = true): Buffer {
  if (payload.length >= 126) throw new Error("fixture only supports short frames");
  return Buffer.concat([Buffer.from([(final ? 0x80 : 0) | opcode, payload.length]), payload]);
}

function parseClientFrame(buffer: Buffer): { frame: ClientFrame; bytes: number } | undefined {
  if (buffer.length < 2) return undefined;
  const masked = (buffer[1]! & 0x80) !== 0;
  let payloadLength = buffer[1]! & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return undefined;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return undefined;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + payloadLength) return undefined;
  const mask = buffer.subarray(offset, offset + maskBytes);
  const encoded = buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLength);
  const payload = Buffer.from(encoded);
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]!;
  }
  return {
    frame: { opcode: buffer[0]! & 0x0f, masked, payload: payload.toString("utf8") },
    bytes: offset + maskBytes + payloadLength,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
