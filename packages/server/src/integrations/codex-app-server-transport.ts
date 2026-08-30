import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HANDSHAKE_BYTES = 64 * 1024;

export interface CodexAppServerTransportOptions {
  socketPath: string;
  requestPath?: string;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
  onMessage: (message: string) => void;
  onClose?: (error?: Error) => void;
}

export interface CodexAppServerTransport {
  send(message: string): void;
  close(): void;
}

export async function connectCodexAppServerTransport(
  options: CodexAppServerTransportOptions,
): Promise<CodexAppServerTransport> {
  const socket = createConnection({ path: options.socketPath });
  const connection = new UnixWebSocketConnection(socket, options);
  await connection.open();
  return connection;
}

class UnixWebSocketConnection implements CodexAppServerTransport {
  private readonly maxMessageBytes: number;
  private receiveBuffer = Buffer.alloc(0);
  private fragments: Buffer[] | undefined;
  private fragmentBytes = 0;
  private openState = false;
  private closeSent = false;
  private closeReported = false;

  constructor(
    private readonly socket: Socket,
    private readonly options: CodexAppServerTransportOptions,
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
  }

  async open(): Promise<void> {
    const key = randomBytes(16).toString("base64");
    const requestPath = this.options.requestPath ?? "/";
    const expectedAccept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    const timeoutMs = this.options.handshakeTimeoutMs ?? 5_000;

    await new Promise<void>((resolve, reject) => {
      let handshake = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Codex App Server WebSocket handshake timed out")), timeoutMs);

      const finish = (error?: Error, remainder?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket.off("error", onError);
        this.socket.off("data", onHandshakeData);
        if (error) {
          this.socket.destroy();
          reject(error);
          return;
        }
        this.openState = true;
        this.attachFrameListeners();
        if (remainder?.length) this.consume(remainder);
        resolve();
      };
      const onError = (error: Error) => finish(error);
      const onHandshakeData = (chunk: Buffer) => {
        handshake = Buffer.concat([handshake, chunk]);
        if (handshake.length > MAX_HANDSHAKE_BYTES) {
          finish(new Error("Codex App Server WebSocket handshake exceeded 64 KiB"));
          return;
        }
        const boundary = handshake.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        try {
          validateHandshake(handshake.subarray(0, boundary).toString("utf8"), expectedAccept);
          finish(undefined, handshake.subarray(boundary + 4));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };

      this.socket.once("error", onError);
      this.socket.on("data", onHandshakeData);
      this.socket.once("connect", () => {
        const request = [
          `GET ${requestPath} HTTP/1.1`,
          "Host: localhost",
          "Connection: Upgrade",
          "Upgrade: websocket",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n");
        this.socket.write(request);
      });
    });
  }

  send(message: string): void {
    if (!this.openState || this.closeSent) throw new Error("Codex App Server transport is not open");
    const payload = Buffer.from(message, "utf8");
    if (payload.length > this.maxMessageBytes) throw new Error("Codex App Server message exceeds configured limit");
    this.socket.write(encodeClientFrame(0x1, payload));
  }

  close(): void {
    if (!this.openState || this.closeSent) return;
    this.closeSent = true;
    this.socket.write(encodeClientFrame(0x8, closePayload(1000, "client closing")));
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 250);
    timer.unref();
  }

  private attachFrameListeners(): void {
    this.socket.on("data", (chunk: Buffer) => this.consume(chunk));
    this.socket.on("error", (error) => this.reportClose(error));
    this.socket.on("close", () => this.reportClose());
  }

  private consume(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    try {
      while (this.parseFrame()) {
        // Parse every complete frame currently buffered.
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private parseFrame(): boolean {
    if (this.receiveBuffer.length < 2) return false;
    const first = this.receiveBuffer[0]!;
    const second = this.receiveBuffer[1]!;
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if ((first & 0x70) !== 0) throw new Error("Codex App Server sent unsupported WebSocket extensions");
    if ((second & 0x80) !== 0) throw new Error("Codex App Server sent an invalid masked server frame");

    let offset = 2;
    let payloadLength = second & 0x7f;
    if (payloadLength === 126) {
      if (this.receiveBuffer.length < 4) return false;
      payloadLength = this.receiveBuffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (this.receiveBuffer.length < 10) return false;
      const length = this.receiveBuffer.readBigUInt64BE(2);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Codex App Server WebSocket frame is too large");
      payloadLength = Number(length);
      offset = 10;
    }
    if (opcode >= 0x8 && (!final || payloadLength > 125)) {
      throw new Error("Codex App Server sent an invalid control frame");
    }
    if (payloadLength > this.maxMessageBytes || this.fragmentBytes + payloadLength > this.maxMessageBytes) {
      throw new Error("Codex App Server message exceeds configured limit");
    }
    if (this.receiveBuffer.length < offset + payloadLength) return false;

    const payload = this.receiveBuffer.subarray(offset, offset + payloadLength);
    this.receiveBuffer = this.receiveBuffer.subarray(offset + payloadLength);
    this.handleFrame(opcode, final, payload);
    return true;
  }

  private handleFrame(opcode: number, final: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      if (!this.closeSent) {
        this.closeSent = true;
        this.socket.write(encodeClientFrame(0x8, payload));
      }
      this.socket.end();
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(encodeClientFrame(0xA, payload));
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x2) throw new Error("Codex App Server sent an unsupported binary frame");

    if (opcode === 0x1) {
      if (this.fragments) throw new Error("Codex App Server interleaved fragmented messages");
      if (final) {
        this.options.onMessage(decodeUtf8(payload));
      } else {
        this.fragments = [Buffer.from(payload)];
        this.fragmentBytes = payload.length;
      }
      return;
    }
    if (opcode === 0x0) {
      if (!this.fragments) throw new Error("Codex App Server sent an unexpected continuation frame");
      this.fragments.push(Buffer.from(payload));
      this.fragmentBytes += payload.length;
      if (final) {
        const message = Buffer.concat(this.fragments, this.fragmentBytes);
        this.fragments = undefined;
        this.fragmentBytes = 0;
        this.options.onMessage(decodeUtf8(message));
      }
      return;
    }
    throw new Error(`Codex App Server sent unsupported WebSocket opcode ${opcode}`);
  }

  private fail(error: Error): void {
    if (!this.closeSent && this.openState) {
      this.closeSent = true;
      this.socket.write(encodeClientFrame(0x8, closePayload(1002, "protocol error")));
    }
    this.socket.destroy();
    this.reportClose(error);
  }

  private reportClose(error?: Error): void {
    if (this.closeReported) return;
    this.closeReported = true;
    this.openState = false;
    this.options.onClose?.(error);
  }
}

function validateHandshake(response: string, expectedAccept: string): void {
  const lines = response.split("\r\n");
  if (!/^HTTP\/1\.[01] 101(?:\s|$)/.test(lines[0] ?? "")) {
    throw new Error(`Codex App Server rejected WebSocket upgrade: ${lines[0] ?? "empty response"}`);
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  if (!headerHasToken(headers.get("upgrade"), "websocket") || !headerHasToken(headers.get("connection"), "upgrade")) {
    throw new Error("Codex App Server returned an invalid WebSocket upgrade response");
  }
  if (headers.get("sec-websocket-accept") !== expectedAccept) {
    throw new Error("Codex App Server returned an invalid WebSocket accept key");
  }
}

function headerHasToken(value: string | undefined, token: string): boolean {
  return value?.split(",").some((item) => item.trim().toLowerCase() === token) ?? false;
}

function decodeUtf8(payload: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(payload);
}

function closePayload(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const lengthBytes = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const header = Buffer.allocUnsafe(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  if (lengthBytes === 0) {
    header[1] = 0x80 | payload.length;
  } else if (lengthBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  mask.copy(header, 2 + lengthBytes);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, masked]);
}
