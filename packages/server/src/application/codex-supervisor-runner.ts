import type { CodexAppServerClientOptions } from "../integrations/codex-app-server-client";
import { CodexAppServerClient } from "../integrations/codex-app-server-client";
import { CodexAppServerConnector } from "../integrations/codex-app-server-connector";
import { CodexSupervisorService } from "./codex-supervisor-service";

const RECONNECT_BACKOFF_MS = [15_000, 60_000, 5 * 60_000] as const;

export interface CodexSupervisorRunnerOptions {
  dataDir: string;
  socketPath: string;
  enabled: boolean;
  scanIntervalMs?: number;
  cycleIntervalMs?: number;
  agentMcpUrl?: string;
  clientFactory?: (options: CodexAppServerClientOptions) => CodexAppServerClient;
  now?: () => Date;
}

export class CodexSupervisorRunner {
  readonly service: CodexSupervisorService;
  private readonly connector: CodexAppServerConnector;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private iterationRunning = false;
  private reconnectFailures = 0;
  private nextConnectAt = 0;
  private nextScanAt = 0;

  constructor(private readonly options: CodexSupervisorRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.service = new CodexSupervisorService(
      options.dataDir, options.socketPath, options.enabled, undefined, this.now, options.agentMcpUrl,
    );
    this.connector = new CodexAppServerConnector({
      socketPath: options.socketPath,
      clientFactory: options.clientFactory,
      onNotification: (notification, connectionId) => this.service.handleNotification(notification, connectionId),
      onServerRequest: (request, connectionId) => this.service.handleServerRequest(request, connectionId),
      onDisconnected: (connectionId, error) => {
        this.service.detachConnection(connectionId, error);
        this.scheduleReconnect();
      },
    });
  }

  start(): void {
    if (!this.options.enabled || !this.stopped) return;
    this.stopped = false;
    this.nextConnectAt = 0;
    this.nextScanAt = 0;
    void this.iterate();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const connectionId = this.connector.getConnectionId();
    if (connectionId) this.service.detachConnection(connectionId, new Error("Codex supervisor stopped"));
    this.connector.disconnect();
    this.service.setNextScanAt(undefined);
  }

  async runOnce(): Promise<void> {
    if (!this.options.enabled) return;
    await this.runWork();
  }

  private async iterate(): Promise<void> {
    if (this.stopped || this.iterationRunning) return;
    this.iterationRunning = true;
    try {
      await this.runWork();
    } catch (error) {
      this.service.setRuntimeError(error);
    } finally {
      this.iterationRunning = false;
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.iterate(), this.options.cycleIntervalMs ?? 5_000);
        this.timer.unref();
      }
    }
  }

  private async runWork(): Promise<void> {
    const now = this.now().getTime();
    if (!this.connector.isConnected() && now >= this.nextConnectAt) {
      try {
        const client = await this.connector.connect();
        this.service.attachConnection(client, this.connector.getConnectionId()!);
        this.reconnectFailures = 0;
        this.nextScanAt = 0;
      } catch (error) {
        this.service.setRuntimeError(error);
        this.scheduleReconnect();
      }
    }
    if (!this.connector.isConnected()) return;
    if (now >= this.nextScanAt) {
      try {
        await this.service.scan();
        this.nextScanAt = this.now().getTime() + (this.options.scanIntervalMs ?? 15_000);
        this.service.setNextScanAt(new Date(this.nextScanAt).toISOString());
      } catch (error) {
        this.service.setRuntimeError(error);
      }
    }
    await this.service.cycle();
  }

  private scheduleReconnect(): void {
    const index = Math.min(this.reconnectFailures, RECONNECT_BACKOFF_MS.length - 1);
    this.nextConnectAt = this.now().getTime() + RECONNECT_BACKOFF_MS[index]!;
    this.reconnectFailures += 1;
  }
}
