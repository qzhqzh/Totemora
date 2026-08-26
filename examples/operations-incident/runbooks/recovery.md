# Recovery procedure

1. Stop new intake only if database commits or idempotency records are inconsistent.
2. For a Provider 504, inspect the request record and its idempotency key before retrying.
3. If an external action has an unknown outcome, **do not automatically replay it**.
4. A Bark circuit may be reset only after the target is healthy; invoice processing continues while notifications are degraded.
5. Record observed evidence and unresolved uncertainty. Never claim a restart or replay happened without an operator receipt.
