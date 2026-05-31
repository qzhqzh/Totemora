# Totemora MVP Plan

The MVP goal is to prove that multiple heterogeneous AI agents can be configured into a tribe, elected into roles, collaborate through structured messages, and produce an auditable task result.

## MVP Scope

Build a local-first TUI product with a minimal runtime and trace storage.

The first version should support:

- configure providers and agents from files
- start one task from TUI or CLI
- elect Chief, Shaman, and at least one Executor role
- run a council planning step
- let the Chief choose one plan
- dispatch small tasks to executors
- record structured messages and tool calls
- review the final result
- generate a final report
- expose a run trace for later web viewing

## Out of Scope

Do not implement these in the first version:

- full autonomous rule mutation
- multi-user SaaS
- desktop client
- visual graph editor
- marketplace of agents
- complex memory evolution
- automatic fine-tuning
- distributed worker cluster

## Phase 1: Local TUI Runtime

Validation target:

```text
totemora run "analyze this repo and propose a project plan"
```

Expected result:

- selected Chief and Shaman are shown
- council produces 2-3 options
- Chief chooses one option with reasons
- task list is generated
- executor agents complete assigned steps
- final answer is reviewed
- run trace is written locally

Minimum commands:

```bash
totemora
totemora run "<goal>"
totemora providers list
totemora agents list
totemora runs
totemora open <run_id>
```

## Phase 2: Web Observatory

Validation target:

```text
TUI starts a run and prints a web trace URL.
```

The web console should be read-heavy:

- run summary
- role assignments
- task timeline
- message timeline
- tool calls
- token and cost usage
- final report
- manual proposals

The web console should not become the main task entry in early versions.

## Phase 3: Learning Loop

Validation target:

```text
After multiple runs, agent reliability and role fitness affect future elections.
```

Add:

- historical success rate
- agent reliability score
- role-specific performance
- manual proposal review
- bounded profile adjustment

## MVP Acceptance Criteria

A first usable version is acceptable when:

- one local tribe can be configured without code changes
- at least two different providers can be registered through the same provider adapter shape
- one task can complete from TUI command to reviewed final report
- all important events are persisted as trace records
- failed runs are inspectable enough to tell where the process broke

## Technical Bias

Prefer a simple local-first implementation:

- config files first, database later
- OpenAI-compatible provider first, special provider adapters later
- local trace files first, server-backed storage later
- TUI-first workflow, web observability second
