## Hard stops

Stop before the risky stage for merge conflicts, stale approval snapshots, unknown external mutation
outcomes that cannot be reconciled, missing credentials, required force-push, unrelated commits on
the target, unique work on a branch scheduled for deletion, failed required checks, ambiguous release
ownership, or material production/data/security risk. Report the exact blocker and last completed
safe stage.

After a retryable failure, reuse the original workflow authorization only when its endpoint, snapshot,
Commit message, files, and target branch still match. Do not ask for the same permission again; do not
silently replay an external mutation whose result is unknown.
