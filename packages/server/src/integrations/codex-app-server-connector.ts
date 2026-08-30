import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexServerNotification,
  type CodexServerRequest,
} from "./codex-app-server-client";

export interface CodexAppServerConnectorOptions {
  socketPath: string;
  clientFactory?: (options: CodexAppServerClientOptions) => CodexAppServerClient;
  onNotification: (notification: CodexServerNotification, connectionId: string) => void;
  onServerRequest: (request: CodexServerRequest, connectionId: string) => void;
  onDisconnected: (connectionId: string, error?: Error) => void;
}

export class CodexAppServerConnector {
  private client: CodexAppServerClient | undefined;
  private connectionId: string | undefined;

  constructor(private readonly options: CodexAppServerConnectorOptions) {}

  async connect(): Promise<CodexAppServerClient> {
    if (this.client) return this.client;
    const connectionId = crypto.randomUUID();
    const factory = this.options.clientFactory ?? ((options) => new CodexAppServerClient(options));
    const client = factory({
      socketPath: this.options.socketPath,
      clientName: "totemora-codex-supervisor",
      onNotification: (notification) => this.options.onNotification(notification, connectionId),
      onServerRequest: (request) => this.options.onServerRequest(request, connectionId),
      onDisconnect: (error) => {
        if (this.connectionId !== connectionId) return;
        this.client = undefined;
        this.connectionId = undefined;
        this.options.onDisconnected(connectionId, error);
      },
    });
    await client.connect();
    this.client = client;
    this.connectionId = connectionId;
    return client;
  }

  disconnect(): void {
    const client = this.client;
    this.client = undefined;
    this.connectionId = undefined;
    client?.close();
  }

  getClient(): CodexAppServerClient | undefined {
    return this.client;
  }

  getConnectionId(): string | undefined {
    return this.connectionId;
  }

  isConnected(): boolean {
    return Boolean(this.client);
  }
}
