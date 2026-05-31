# Totemora Execution Plan

This document turns the MVP into executable GitHub-sized work items.

Each numbered item should usually become one Issue and one PR. If an item touches too many files or introduces unclear behavior, split it before implementation.

## Route Alignment

The plan is aligned with the current Totemora goal:

- **Core product form**: TUI-first control plane, not web-first.
- **Web role**: read-heavy observability and replay, not the early primary operation surface.
- **Runtime role**: tribe orchestration engine for election, council planning, task dispatch, help escalation, review, trace, and manual proposals.
- **AI extensibility**: providers are adapters; the tribe schedules agents, not raw model vendors.
- **Collaboration model**: structured messages and trace records are required before complex autonomous behavior.
- **Autonomy limit**: agents can propose new rules, but early versions do not silently mutate the tribe manual.

Do not accept changes that move the product toward a generic chatbot, a pure web admin panel, or a hard-coded `planner -> executor -> reviewer` pipeline.

## Development Workflow

Use this workflow for new features:

```text
Issue -> feat/* branch -> implementation + checks -> conventional commit -> PR
```

Issue titles should follow this style:

```text
[M1.1] Define provider config schema
```

PR titles should stay under 70 characters and use conventional commit style where possible:

```text
feat(config): define provider schema
```

Every PR description should include:

- what changed
- why it changed
- how it was tested
- linked Issue

## Cross-Cutting Guardrails

- No committed API keys, tokens, or local secrets.
- API keys are referenced by environment variable name only.
- Do not add runtime dependencies without explaining why in the PR.
- Keep each PR focused on one behavior change.
- Prefer local files for MVP trace/config storage; do not introduce a database until a later decision.
- Do not build Web Observatory features before the runtime can produce useful traces.
- Do not add agent memory evolution before trace, review, and manual proposal flows exist.

## Milestone 0: Repository Baseline

Goal: make the repository ready for feature development without implementing product behavior.

### M0.1 Initialize Bun Workspace

- **Issue**: `[M0.1] Initialize Bun workspace`
- **Goal**: create a minimal monorepo workspace.
- **Scope**:
  - root `package.json`
  - Bun lockfile if generated
  - root scripts: `lint`, `typecheck`, `test`
  - package directories with placeholder package manifests
- **Packages**:
  - `packages/core`
  - `packages/providers`
  - `packages/tui`
  - `packages/server`
  - `packages/web`
- **Acceptance**:
  - `bun install` succeeds
  - `bun run lint`, `bun run typecheck`, and `bun run test` exist
  - checks can pass with placeholder packages
- **Depends on**: none

### M0.2 Add Repository Hygiene Files

- **Issue**: `[M0.2] Add repository hygiene files`
- **Goal**: prevent accidental local or secret files from entering the repo.
- **Scope**:
  - `.gitignore`
  - `.env.example`
  - optional `.editorconfig`
- **Acceptance**:
  - `.env` and local trace output paths are ignored
  - `.env.example` contains variable names only
  - no real secrets exist in the repo
- **Depends on**: none

### M0.3 Add Development Guide

- **Issue**: `[M0.3] Add development guide`
- **Goal**: document the contributor workflow.
- **Scope**:
  - `docs/development.md`
  - command reference
  - PR checklist
  - Issue/branch/commit conventions
- **Acceptance**:
  - a contributor can install, run checks, and open a PR from docs alone
  - guide matches `Issue -> feat/* -> conventional commit -> PR`
- **Depends on**: M0.1

## Milestone 1: Configuration Foundation

Goal: load and validate a local tribe definition without calling any AI provider.

### M1.1 Define Config Types

- **Issue**: `[M1.1] Define config types`
- **Goal**: turn `docs/config-model.md` into typed runtime objects.
- **Scope**:
  - provider config type
  - agent config type
  - role config type
  - tribe config type
  - capability score type
- **Acceptance**:
  - types represent all examples in `docs/config-model.md`
  - no provider-specific code enters `packages/core`
- **Depends on**: M0.1

### M1.2 Implement Config Loader

- **Issue**: `[M1.2] Implement config loader`
- **Goal**: load config files from a local config directory.
- **Scope**:
  - default config path resolution
  - explicit `--config-dir` support if CLI exists
  - parse provider, agent, role, and tribe files
- **Acceptance**:
  - valid config files load into typed objects
  - missing files produce actionable errors
  - loader performs no provider network calls
- **Depends on**: M1.1

### M1.3 Implement Config Validation

- **Issue**: `[M1.3] Implement config validation`
- **Goal**: fail early on invalid local tribe definitions.
- **Scope**:
  - missing provider reference
  - missing model
  - duplicate agent id
  - unknown role
  - invalid capability score outside `0..1`
  - secret values stored directly instead of env var names
- **Acceptance**:
  - each invalid sample has a focused test
  - validation errors name the bad field and file
- **Depends on**: M1.2

### M1.4 Add Sample Local Tribe Config

- **Issue**: `[M1.4] Add sample local tribe config`
- **Goal**: provide a non-secret example tribe.
- **Scope**:
  - `configs/example/providers.yaml`
  - `configs/example/agents.yaml`
  - `configs/example/roles.yaml`
  - `configs/example/tribe.yaml`
- **Acceptance**:
  - sample config validates
  - sample includes at least two provider ids
  - sample contains no real API keys
- **Depends on**: M1.3

### M1.5 Add Config Inspection Commands

- **Issue**: `[M1.5] Add config inspection commands`
- **Goal**: let users inspect config from the terminal.
- **Scope**:
  - `totemora providers list`
  - `totemora agents list`
  - `totemora tribe inspect`
- **Acceptance**:
  - commands show provider ids, agent ids, eligible roles, and tools
  - invalid config exits non-zero with clear output
  - commands make no model API requests
- **Depends on**: M1.4

## Milestone 2: Provider Layer

Goal: call heterogeneous model APIs through one adapter shape.

### M2.1 Define Provider Contract

- **Issue**: `[M2.1] Define provider contract`
- **Goal**: define the only interface the runtime uses to call models.
- **Scope**:
  - `AgentProvider.generate()`
  - `AgentRequest`
  - `AgentResponse`
  - usage metadata
  - normalized provider error type
- **Acceptance**:
  - `packages/core` can depend on the contract without importing concrete providers
  - response can carry raw provider payload for trace/debug use
- **Depends on**: M1.1

### M2.2 Implement OpenAI-Compatible Adapter

- **Issue**: `[M2.2] Implement OpenAI-compatible provider`
- **Goal**: support OpenAI, Qwen, Kimi, GLM, and similar APIs through one adapter.
- **Scope**:
  - base URL
  - API key env lookup
  - model selection
  - text response
  - JSON response mode when available
  - timeout configuration
- **Acceptance**:
  - missing env var fails before request
  - provider errors are normalized
  - adapter has tests using mocked HTTP responses
- **Depends on**: M2.1

### M2.3 Add Provider Registry

- **Issue**: `[M2.3] Add provider registry`
- **Goal**: instantiate provider adapters from config.
- **Scope**:
  - adapter lookup by provider type
  - provider instance lookup by provider id
  - unsupported provider type error
- **Acceptance**:
  - configured `openai_compatible` providers instantiate
  - unsupported provider type exits with actionable error
- **Depends on**: M2.2

### M2.4 Add Provider Smoke Command

- **Issue**: `[M2.4] Add provider smoke command`
- **Goal**: verify provider configuration manually.
- **Scope**:
  - `totemora providers smoke <provider_id>`
  - optional `--agent <agent_id>`
  - latency and model output summary
- **Acceptance**:
  - success prints provider id, model, latency, and short response
  - auth/base URL failures are clear
  - smoke command does not create run traces
- **Depends on**: M2.3

## Milestone 3: Agent Registry and Election

Goal: turn configured models into selectable tribe members.

### M3.1 Implement Agent Registry

- **Issue**: `[M3.1] Implement agent registry`
- **Goal**: make configured agents queryable by id, role, and tool capability.
- **Scope**:
  - lookup by id
  - list by eligible role
  - list by tool permission
  - validation against provider and role configs
- **Acceptance**:
  - duplicate ids fail
  - unknown providers fail
  - unknown roles fail
- **Depends on**: M1.4

### M3.2 Implement Role Fitness Scoring

- **Issue**: `[M3.2] Implement role fitness scoring`
- **Goal**: rank agents for roles using capability weights.
- **Scope**:
  - weighted score calculation
  - deterministic tie-breaker
  - explanation object for selected score
- **Acceptance**:
  - Chief ranking favors reasoning, review, reliability, and obedience
  - Worker ranking favors speed, cost, obedience, and reliability
  - tests cover ranking and tie-break behavior
- **Depends on**: M3.1

### M3.3 Implement Election Engine

- **Issue**: `[M3.3] Implement election engine`
- **Goal**: select run roles from the agent registry.
- **Scope**:
  - required roles
  - max agents per role
  - incompatible duplicate assignments
  - election explanation
- **Acceptance**:
  - required roles must be filled or run preparation fails
  - same agent is not assigned incompatible roles in one run
  - election result includes why each agent was selected
- **Depends on**: M3.2

### M3.4 Add Election Preview Command

- **Issue**: `[M3.4] Add election preview command`
- **Goal**: inspect likely role assignment before a real run.
- **Scope**:
  - `totemora tribe elect --goal "<goal>"`
  - display role, agent, score, and reason
- **Acceptance**:
  - command does not call model providers
  - output shows Chief, Shaman, and at least one Warrior when available
  - missing role capacity exits non-zero
- **Depends on**: M3.3

## Milestone 4: Trace and Message Foundation

Goal: make runs auditable before complex autonomy exists.

### M4.1 Define Run Data Model

- **Issue**: `[M4.1] Define run data model`
- **Goal**: persist one run from command input to final report.
- **Scope**:
  - run id
  - user goal
  - status
  - role assignments
  - tasks
  - messages
  - provider calls
  - review result
  - final report
- **Acceptance**:
  - model can represent pending, running, succeeded, failed, and cancelled runs
  - incomplete runs remain inspectable
- **Depends on**: M3.3

### M4.2 Implement Local Trace Store

- **Issue**: `[M4.2] Implement local trace store`
- **Goal**: save run data locally without a database.
- **Scope**:
  - create run
  - append event
  - list runs
  - read run
  - handle partial writes defensively
- **Acceptance**:
  - trace files are ignored by git by default
  - failed and incomplete runs can be read
  - tests cover append/read/list
- **Depends on**: M4.1

### M4.3 Implement Structured Message Validation

- **Issue**: `[M4.3] Implement structured message validation`
- **Goal**: prevent agent collaboration from becoming free-form chat.
- **Scope**:
  - `proposal`
  - `decision`
  - `task_assignment`
  - `progress`
  - `blocker`
  - `help_request`
  - `review`
  - `final_report`
- **Acceptance**:
  - every agent-to-agent message has type, sender, run id, timestamp, and content
  - invalid message types fail validation
  - messages can link artifacts
- **Depends on**: M4.1

### M4.4 Add Run Inspection Commands

- **Issue**: `[M4.4] Add run inspection commands`
- **Goal**: inspect saved runs from terminal.
- **Scope**:
  - `totemora runs`
  - `totemora runs show <run_id>`
  - `totemora runs messages <run_id>`
- **Acceptance**:
  - user can identify where a failed run stopped
  - output includes role assignment, task state, and final status
- **Depends on**: M4.2, M4.3

## Milestone 5: Council Planning

Goal: complete the first meaningful multi-agent collaboration loop.

### M5.1 Implement Rule-Based Task Analyzer

- **Issue**: `[M5.1] Implement rule-based task analyzer`
- **Goal**: classify a user command without requiring a model call.
- **Scope**:
  - task type
  - needed capabilities
  - expected output type
  - acceptance criteria draft
- **Acceptance**:
  - coding, research, review, and planning commands produce different profiles
  - analyzer output can feed election scoring
- **Depends on**: M3.3

### M5.2 Define Council Prompt Contracts

- **Issue**: `[M5.2] Define council prompt contracts`
- **Goal**: standardize proposal and decision outputs.
- **Scope**:
  - proposal schema
  - Chief decision schema
  - task list schema
  - failure schema for invalid model output
- **Acceptance**:
  - prompts require structured output
  - invalid output can be rejected and traced
  - schemas include validation method for each proposal
- **Depends on**: M4.3

### M5.3 Implement Council Proposal Step

- **Issue**: `[M5.3] Implement council proposal step`
- **Goal**: ask selected high-capability agents for solution options.
- **Scope**:
  - Chief proposal request
  - Shaman proposal request
  - optional Scout request
  - provider call trace
- **Acceptance**:
  - produces 2-3 structured proposals when configured agents are available
  - proposals include approach, risks, expected tasks, and validation method
  - proposals are persisted as typed messages
- **Depends on**: M2.3, M5.2

### M5.4 Implement Chief Decision Step

- **Issue**: `[M5.4] Implement Chief decision step`
- **Goal**: choose one plan before execution starts.
- **Scope**:
  - selected plan
  - rejection reasons for alternatives
  - executable task list
  - task owner roles
- **Acceptance**:
  - only one plan enters execution
  - decision is persisted as a typed message
  - task list has owner role and acceptance criteria
- **Depends on**: M5.3

### M5.5 Add Planning-Only Run Command

- **Issue**: `[M5.5] Add planning-only run command`
- **Goal**: prove the council loop before task execution.
- **Scope**:
  - `totemora run --plan-only "<goal>"`
  - election
  - proposals
  - Chief decision
  - trace output
- **Acceptance**:
  - command produces a reviewed plan without executing tasks
  - run trace contains election, proposals, decision, and final plan
- **Depends on**: M5.4

## Milestone 6: Execution Loop

Goal: execute a simple task graph with bounded autonomy.

### M6.1 Define Task State Machine

- **Issue**: `[M6.1] Define task state machine`
- **Goal**: make task execution explicit and traceable.
- **Scope**:
  - `pending`
  - `running`
  - `succeeded`
  - `failed`
  - `blocked`
  - `cancelled`
- **Acceptance**:
  - invalid transitions fail
  - every transition writes a trace event
- **Depends on**: M4.2

### M6.2 Implement Deterministic Task Dispatch

- **Issue**: `[M6.2] Implement deterministic task dispatch`
- **Goal**: assign and run tasks in a simple predictable order.
- **Scope**:
  - owner role resolution
  - agent assignment
  - sequential execution for MVP
  - task result artifact
- **Acceptance**:
  - tasks run in deterministic order
  - each task result is traceable
  - failed task stops or blocks the run cleanly
- **Depends on**: M5.4, M6.1

### M6.3 Implement Help Escalation

- **Issue**: `[M6.3] Implement help escalation`
- **Goal**: make executors ask for advice after repeated failure.
- **Scope**:
  - retry counter
  - help request message
  - Shaman or Chief advice response
  - retry with advice
- **Acceptance**:
  - after configured retry limit, executor asks for help
  - advisor gives guidance rather than taking over execution
  - help interaction is visible in trace
- **Depends on**: M6.2

### M6.4 Implement Review Gate

- **Issue**: `[M6.4] Implement review gate`
- **Goal**: require acceptance before final report.
- **Scope**:
  - review request
  - pass/fail result
  - revision request
  - explicit failure report
- **Acceptance**:
  - Chief can accept or reject result
  - final report is produced only after acceptance or explicit failure
  - review result is persisted
- **Depends on**: M6.2

### M6.5 Add End-to-End Local Run Command

- **Issue**: `[M6.5] Add end-to-end local run command`
- **Goal**: run a complete local tribe workflow from the terminal.
- **Scope**:
  - `totemora run "<goal>"`
  - election
  - council planning
  - task execution
  - help escalation if needed
  - review
  - final report
- **Acceptance**:
  - command exits zero on accepted result
  - command exits non-zero on failed run
  - output includes run id and trace inspection command
- **Depends on**: M6.3, M6.4

## Milestone 7: TUI Control Plane

Goal: make the runtime usable as a terminal-native product.

### M7.1 Add Minimal Interactive TUI Shell

- **Issue**: `[M7.1] Add minimal interactive TUI shell`
- **Goal**: provide the first `totemora` interactive entry.
- **Scope**:
  - command input area
  - current tribe summary
  - current run summary
  - live message stream
- **Acceptance**:
  - user can start a run from TUI
  - selected roles and task progress are visible
  - user can interrupt a run
- **Depends on**: M6.5

### M7.2 Add TUI Provider and Agent Views

- **Issue**: `[M7.2] Add TUI provider and agent views`
- **Goal**: make local tribe composition visible.
- **Scope**:
  - provider list
  - agent list
  - role eligibility
  - tool permissions
- **Acceptance**:
  - TUI can inspect configured providers and agents
  - no provider network calls happen during inspection
- **Depends on**: M1.5, M7.1

### M7.3 Add Human Approval Points

- **Issue**: `[M7.3] Add human approval points`
- **Goal**: prevent unsafe or expensive actions from running silently.
- **Scope**:
  - shell tool approval
  - file edit approval
  - expensive provider call approval when configured
  - run cancellation
- **Acceptance**:
  - user can approve, reject, or cancel
  - rejected action is captured in trace
  - cancelled run remains inspectable
- **Depends on**: M7.1

## Milestone 8: Web Observatory

Goal: visualize runs after the TUI workflow can produce useful traces.

### M8.1 Add Read-Only Trace API

- **Issue**: `[M8.1] Add read-only trace API`
- **Goal**: expose local run data through a small API.
- **Scope**:
  - list runs
  - get run summary
  - get messages
  - get provider calls
  - get task timeline
- **Acceptance**:
  - API is read-only for MVP
  - failed and partial runs are visible
  - API reads from the same local trace store as TUI commands
- **Depends on**: M4.2, M6.5

### M8.2 Add Run Detail Page

- **Issue**: `[M8.2] Add run detail page`
- **Goal**: show one run's collaboration process.
- **Scope**:
  - role assignments
  - task timeline
  - message timeline
  - final report
  - cost and latency summary
- **Acceptance**:
  - TUI can print a URL for a run
  - user can understand who decided, who executed, and why the run passed or failed
- **Depends on**: M8.1

### M8.3 Add Manual Proposal View

- **Issue**: `[M8.3] Add manual proposal view`
- **Goal**: show proposed tribe manual entries without auto-applying them.
- **Scope**:
  - list manual proposals from runs
  - show proposer, reason, and target rule
  - display accepted/rejected/pending status if available
- **Acceptance**:
  - manual proposals are observable
  - no web action mutates active rules in MVP
- **Depends on**: M8.2

## Milestone 9: Learning Loop

Goal: improve future elections from recorded outcomes without uncontrolled self-mutation.

### M9.1 Record Agent Performance Outcomes

- **Issue**: `[M9.1] Record agent performance outcomes`
- **Goal**: capture per-agent run outcomes for future ranking.
- **Scope**:
  - role assignment outcome
  - task success/failure
  - review pass/fail
  - latency and token usage
- **Acceptance**:
  - outcome data is stored in trace or local profile data
  - raw provider output is not required for scoring
- **Depends on**: M6.5

### M9.2 Apply Bounded Reliability Scoring

- **Issue**: `[M9.2] Apply bounded reliability scoring`
- **Goal**: let historical outcomes influence elections safely.
- **Scope**:
  - reliability score calculation
  - score bounds
  - decay or minimum sample handling
- **Acceptance**:
  - unreliable agents rank lower over time
  - small sample sizes do not dominate configured capability scores
  - scoring explanation shows history contribution
- **Depends on**: M9.1

### M9.3 Add Manual Proposal Acceptance Flow

- **Issue**: `[M9.3] Add manual proposal acceptance flow`
- **Goal**: allow proposed tribe rules to become active through approval.
- **Scope**:
  - pending proposal
  - accept/reject action
  - active manual entry
  - trace link to source run
- **Acceptance**:
  - no proposal becomes active without explicit approval
  - accepted entries are visible to future runs
- **Depends on**: M8.3

## Recommended Build Order

```text
M0.1 -> M0.2 -> M0.3
M1.1 -> M1.2 -> M1.3 -> M1.4 -> M1.5
M2.1 -> M2.2 -> M2.3 -> M2.4
M3.1 -> M3.2 -> M3.3 -> M3.4
M4.1 -> M4.2 -> M4.3 -> M4.4
M5.1 -> M5.2 -> M5.3 -> M5.4 -> M5.5
M6.1 -> M6.2 -> M6.3 -> M6.4 -> M6.5
M7.1 -> M7.2 -> M7.3
M8.1 -> M8.2 -> M8.3
M9.1 -> M9.2 -> M9.3
```

## MVP Release Criteria

The MVP can be tagged when:

- a user can configure at least two agents from different providers
- `totemora run "<goal>"` completes one council-planned run
- Chief, Shaman, and Warrior roles are selected automatically
- the run records election, proposals, decision, tasks, messages, provider calls, review, and final report
- failed runs are inspectable from terminal commands
- TUI is the main operation surface
- Web Observatory can open a run and show the collaboration timeline

## Stop-and-Recheck Points

Pause and review the product direction after:

- **M1.5**: config model is real; check whether provider/agent/role separation still feels correct.
- **M3.4**: election is visible; check whether role assignment matches the tribe metaphor and practical task needs.
- **M5.5**: council planning works; check whether Totemora is more than a single-agent planner.
- **M6.5**: full run works; check whether execution is traceable and bounded.
- **M8.2**: web view exists; check whether Web Observatory remains observability-first.

At each checkpoint, compare the implementation against `docs/README.md` and `docs/mvp.md`. If the implementation contradicts those documents, update the decision explicitly before continuing.
