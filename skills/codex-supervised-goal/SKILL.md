---
name: codex-supervised-goal
description: Use when a Codex task is explicitly managed by Totemora's long-running goal supervisor. Keep work moving within the registered Workplace, report durable checkpoints, and raise bounded choices when owner input is genuinely required.
---

# Codex Supervised Goal

Work only toward the active Codex goal and its acceptance criteria. Treat the repository's
`AGENTS.md`, the registered Workplace policy, and the user's latest instruction as higher-priority
constraints.

## Execution loop

1. Inspect the current repository state and the latest completed work before changing anything.
2. Choose the smallest useful next step that advances the active goal.
3. Implement and validate that step with repository-native checks.
4. Call `codex_report_checkpoint` with the result, evidence, remaining work, and next intended step.
5. Continue until the goal is ready for the supervisor's independent verification turn.

Do not merely restate a plan when a safe, in-scope implementation step is available. Preserve
unrelated workspace changes, and keep every diff traceable to the active goal.

## Human interaction

Use `codex_raise_interaction` only when the answer materially changes the result or permission
boundary:

- `suggest`: offer 2-3 reversible options, identify one recommendation, and provide a safe default
  that may be applied after the stated expiry.
- `decision`: offer 2-3 mutually exclusive options and no automatic default.
- `approval`: describe one concrete side effect; never approve it yourself.
- `fyi`: report material information without presenting options.

Do not use an interaction to offload routine engineering judgment. Never expose secrets in an
interaction body or checkpoint.

## Boundaries

- You may report checkpoints and raise interactions only for the current task and turn.
- You may not manage, pause, resume, stop, continue, steer, or approve a Codex task.
- You may not mint or reuse capability tokens, answer your own interaction, or alter supervisor
  budgets, deadlines, leases, concurrency, or retry counters.
- If a turn fails, try a materially different bounded strategy and explain the change in the next
  checkpoint. Do not repeat the same failed action indefinitely.
- When the goal appears complete, run the applicable acceptance checks and report
  `ready_for_verification`. The supervisor, not this turn, decides final completion.
