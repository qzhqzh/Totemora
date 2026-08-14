export interface RecurringServiceDefinition {
  id: string;
  interval_ms: number;
  run: () => Promise<unknown>;
}

export interface RecurringServiceState {
  id: string;
  running: boolean;
  runs: number;
  skipped_overlaps: number;
  failures: number;
  last_started_at?: string;
  last_finished_at?: string;
  last_error?: string;
}

export class RecurringServiceRunner {
  private readonly definitions = new Map<string, RecurringServiceDefinition>();
  private readonly states = new Map<string, RecurringServiceState>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(definitions: RecurringServiceDefinition[]) {
    for (const definition of definitions) {
      if (!definition.id.trim() || this.definitions.has(definition.id)) {
        throw new Error(`Duplicate or empty recurring service id: ${definition.id}`);
      }
      if (!Number.isInteger(definition.interval_ms) || definition.interval_ms < 1_000) {
        throw new Error(`Recurring service ${definition.id} interval must be at least 1000ms`);
      }
      this.definitions.set(definition.id, definition);
      this.states.set(definition.id, {
        id: definition.id, running: false, runs: 0, skipped_overlaps: 0, failures: 0,
      });
    }
  }

  start(): void {
    for (const definition of this.definitions.values()) {
      if (this.timers.has(definition.id)) continue;
      const timer = setInterval(() => {
        void this.tick(definition.id).catch((error) => {
          console.error(`Scheduled ${definition.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, definition.interval_ms);
      timer.unref();
      this.timers.set(definition.id, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  async tick(id: string): Promise<"completed" | "failed" | "skipped_overlap"> {
    const definition = this.definitions.get(id);
    const state = this.states.get(id);
    if (!definition || !state) throw new Error(`Recurring service not found: ${id}`);
    if (state.running) {
      state.skipped_overlaps += 1;
      return "skipped_overlap";
    }
    state.running = true;
    state.runs += 1;
    state.last_started_at = new Date().toISOString();
    state.last_error = undefined;
    try {
      await definition.run();
      return "completed";
    } catch (error) {
      state.failures += 1;
      state.last_error = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: "recurring_service_failed", service_id: id,
        failures: state.failures, error: state.last_error,
      }));
      return "failed";
    } finally {
      state.running = false;
      state.last_finished_at = new Date().toISOString();
    }
  }

  status(): RecurringServiceState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }
}
