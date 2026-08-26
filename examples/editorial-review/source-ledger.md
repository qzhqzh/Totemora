# Source ledger

- A — `job-store.ts`: job and retry input are written to durable storage.
- B — `recurring-service-runner.ts`: restart-interrupted ticks become failures.
- C — `action-journal.ts`: expired uncertain external actions are not replayed.

All three entries are repository observations. No production incident metrics were supplied.
