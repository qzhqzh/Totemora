import { StateDatabase } from "../state-database";

export interface IntelligenceSourceMetadata {
  id: string;
  name: string;
  kind: string;
  url: string;
  summary: string;
}

export interface IntelligenceSourceHealth extends IntelligenceSourceMetadata {
  status: "ready" | "degraded";
  last_item_count: number;
  consecutive_failures: number;
  last_success_at?: string;
  last_failure_at?: string;
  error?: string;
  updated_at: string;
}

const NAMESPACE = "intelligence:source-health";

export class IntelligenceSourceHealthStore {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  list(): IntelligenceSourceHealth[] {
    return this.state.listRecords<IntelligenceSourceHealth>(NAMESPACE)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  recordSuccess(metadata: IntelligenceSourceMetadata, itemCount: number, now = new Date()): void {
    const timestamp = now.toISOString();
    this.state.putRecord(NAMESPACE, metadata.id, {
      ...metadata,
      status: "ready",
      last_item_count: Math.max(0, Math.floor(itemCount)),
      consecutive_failures: 0,
      last_success_at: timestamp,
      updated_at: timestamp,
    } satisfies IntelligenceSourceHealth);
  }

  recordFailure(metadata: IntelligenceSourceMetadata, error: unknown, now = new Date()): void {
    const timestamp = now.toISOString();
    const existing = this.list().find((item) => item.id === metadata.id);
    this.state.putRecord(NAMESPACE, metadata.id, {
      ...metadata,
      status: "degraded",
      last_item_count: existing?.last_item_count ?? 0,
      consecutive_failures: (existing?.consecutive_failures ?? 0) + 1,
      ...(existing?.last_success_at ? { last_success_at: existing.last_success_at } : {}),
      last_failure_at: timestamp,
      error: safeError(error),
      updated_at: timestamp,
    } satisfies IntelligenceSourceHealth, undefined, timestamp);
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500)
    || "Unknown intelligence source error";
}
