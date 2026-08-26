import { StateDatabase } from "./state-database";
import type { RecurringServiceState, RecurringServiceStatePersistence } from "./recurring-service-runner";

interface StoredRecurringServiceState {
  schema_version: 1;
  state: RecurringServiceState;
}

const NAMESPACE = "operations:recurring-services";

export class RecurringServiceStateRepository implements RecurringServiceStatePersistence {
  private readonly state: StateDatabase;

  constructor(dataDir: string) {
    this.state = StateDatabase.open(dataDir);
  }

  load(id: string): RecurringServiceState | undefined {
    const stored = this.state.listRecords<StoredRecurringServiceState>(NAMESPACE)
      .find((item) => item.schema_version === 1 && item.state?.id === id);
    return stored && validState(stored.state) ? structuredClone(stored.state) : undefined;
  }

  save(value: RecurringServiceState): void {
    this.state.putRecord(NAMESPACE, value.id, {
      schema_version: 1,
      state: structuredClone(value),
    } satisfies StoredRecurringServiceState, value.last_started_at, new Date().toISOString());
  }
}

function validState(value: RecurringServiceState): boolean {
  return typeof value.id === "string"
    && typeof value.running === "boolean"
    && [value.runs, value.skipped_overlaps, value.failures]
      .every((count) => Number.isSafeInteger(count) && count >= 0)
    && [value.last_started_at, value.last_finished_at, value.last_error]
      .every((item) => item === undefined || typeof item === "string");
}
