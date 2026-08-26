# Editorial brief

Topic: durable background jobs.

Verified facts:

- A queued job is persisted before background execution starts.
- On restart, a previously running job becomes failed and retryable.
- An external action with an unknown outcome is quarantined instead of automatically replayed.

Boundary: the evidence does not quantify cost savings or claim zero duplicate deliveries.

Primary references: `source-ledger.md` entries A, B, and C.
