import type { RecurringServiceState } from "../recurring-service-runner";
import type { DealsService } from "./deals-service";
import type { ForwardedRelayService } from "./forwarded-relay-service";

/** Scheduler completion is distinct from the health of an upstream source. */
export async function recurringServiceHealth(input: {
  states: RecurringServiceState[];
  deals: Pick<DealsService, "status">;
  forwarded: Pick<ForwardedRelayService, "status">;
}) {
  const deals = input.deals.status();
  const forwarded = await input.forwarded.status();
  return input.states.map((state) => {
    if (state.id === "deals.watch") return { ...state, source_health: deals.source_health };
    if (state.id === "forwarded.relay") return { ...state, source_health: {
      status: !forwarded.configured ? "disabled" : forwarded.polling ? "backoff" : forwarded.source?.last_error ? "blocked"
        : forwarded.source?.last_success_at ? "ready" : "not_started",
      ...(forwarded.polling ? { retry_after: forwarded.polling.next_poll_at, failure_kind: forwarded.polling.failure_kind } : {}),
      ...(forwarded.source?.last_error ? { error: forwarded.source.last_error } : {}),
    } };
    return state;
  });
}
