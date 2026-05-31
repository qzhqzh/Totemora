# Totemora Execution Plan

This document breaks the MVP into implementation-sized work items. Each item should usually become one Issue and one PR.

## Milestone 0: Repository Baseline

Goal: make the repository ready for feature development without implementing product behavior.

### 0.1 Initialize Workspace

- **Goal**: create the minimal project workspace for core, providers, TUI, server, and web packages.
- **Deliverables**:
  - package workspace structure
  - root README entrypoint
  - root scripts for test, lint, and type check
  - basic ignore files
- **Acceptance**:
  - fresh clone can install dependencies
  - root checks run without product code
  - no API keys or local secrets are committed
- **Notes**:
  - Use `bun` for frontend/package scripts.
  - Do not introduce runtime dependencies until a package needs them.

### 0.2 Add Development Conventions

- **Goal**: document how contributors run, test, and submit changes.
- **Deliverables**:
  - development guide
  - PR checklist
  - command reference
- **Acceptance**:
  - a contributor can set up the repo from docs alone
  - PR workflow matches Issue -> feature branch -> conventional commit -> PR

## Milestone 1: Configuration Foundation

Goal: load a local tribe definition without calling any AI provider.

### 1.1 Define Config Schema

- **Goal**: convert `docs/config-model.md` into concrete typed config objects.
- **Deliverables**:
  - provider config type
  - agent config type
  - role config type
  - tribe config type
  - config validation errors with actionable messages
- **Acceptance**:
  - valid sample config loads successfully
  - missing provider, missing model, invalid capability score, and unknown role produce clear errors
  - API keys are referenced by env var name only

### 1.2 Add Sample Local Tribe

- **Goal**: provide a non-secret local example tribe.
- **Deliverables**:
  - example provider config
  - example agent config
  - example role config
  - example tribe config
- **Acceptance**:
  - sample config has no real secrets
  - config loader can load the sample
  - README explains required environment variables

### 1.3 Add Config CLI Commands

- **Goal**: let users inspect local configuration from the terminal.
- **Deliverables**:
  - `totemora providers list`
  - `totemora agents list`
  - `totemora tribe inspect`
- **Acceptance**:
  - commands print provider, agent, role, and tribe summaries
  - commands fail clearly when config is missing or invalid
  - no provider network calls happen during inspection

## Milestone 2: Provider Layer

Goal: call heterogeneous models through one adapter shape.

### 2.1 Implement Provider Interface

- **Goal**: define the runtime-facing provider contract.
- **Deliverables**:
  - `AgentProvider.generate()`
  - `AgentRequest`
  - `AgentResponse`
  - usage metadata shape
- **Acceptance**:
  - core runtime can depend on the interface without provider-specific imports
  - responses can carry raw provider payloads for trace/debug use

### 2.2 Implement OpenAI-Compatible Provider

- **Goal**: support OpenAI-compatible APIs as the first provider adapter.
- **Deliverables**:
  - base URL support
  - API key env lookup
  - model selection
  - text response support
  - JSON response mode support when available
- **Acceptance**:
  - OpenAI, Qwen, Kimi, and GLM can be configured through the same adapter type
  - missing env var fails before making a request
  - provider errors are normalized for the runtime

### 2.3 Add Provider Smoke Command

- **Goal**: verify one provider/agent can answer a small prompt.
- **Deliverables**:
  - `totemora providers smoke <provider_id>`
  - optional `--agent <agent_id>`
- **Acceptance**:
  - command prints model, latency, and short response
  - command does not write run traces
  - failed auth or invalid base URL has clear output

## Milestone 3: Agent Registry and Election

Goal: turn configured models into selectable tribe members.

### 3.1 Implement Agent Registry

- **Goal**: load agents with provider bindings, capability profiles, role eligibility, and tools.
- **Deliverables**:
  - registry query by id
  - registry query by eligible role
  - validation that every agent references an existing provider
- **Acceptance**:
  - duplicate agent ids fail
  - unknown providers fail
  - unknown roles fail

### 3.2 Implement Role Fitness Scoring

- **Goal**: rank agents for roles using configured capability weights.
- **Deliverables**:
  - weighted score calculation
  - role-specific ranking
  - deterministic tie-breaker
- **Acceptance**:
  - Chief favors reasoning, review, reliability, and obedience
  - Worker favors speed, cost, obedience, and reliability
  - output explains why each selected agent was chosen

### 3.3 Implement Election Engine

- **Goal**: select required roles for a run.
- **Deliverables**:
  - Chief selection
  - Shaman selection
  - Warrior selection
  - optional Worker/Scout/Reviewer selection
- **Acceptance**:
  - required roles must be filled or the run fails before provider calls
  - same agent is not assigned incompatible roles in one run
  - election result is traceable

## Milestone 4: Run Trace and Message Protocol

Goal: make every run auditable before execution becomes complex.

### 4.1 Define Run Data Model

- **Goal**: persist one run from command input to final report.
- **Deliverables**:
  - run id
  - user goal
  - role assignments
  - task list
  - message events
  - provider calls
  - review result
  - final report
- **Acceptance**:
  - run data can be written and read locally
  - incomplete and failed runs are still inspectable

### 4.2 Implement Structured Messages

- **Goal**: prevent agent collaboration from becoming free-form chat.
- **Deliverables**:
  - proposal
  - decision
  - task_assignment
  - progress
  - blocker
  - help_request
  - review
  - final_report
- **Acceptance**:
  - every agent-to-agent communication has a message type
  - messages include sender, optional recipient, run id, and timestamp
  - invalid message types fail validation

### 4.3 Add Trace Inspection Commands

- **Goal**: inspect saved runs from terminal.
- **Deliverables**:
  - `totemora runs`
  - `totemora runs show <run_id>`
  - `totemora runs messages <run_id>`
- **Acceptance**:
  - user can identify where a failed run stopped
  - output includes role assignment, task state, and final status

## Milestone 5: Council Planning

Goal: complete the first meaningful multi-agent collaboration loop.

### 5.1 Implement Task Analyzer

- **Goal**: classify a user command into a lightweight task profile.
- **Deliverables**:
  - task type
  - needed capabilities
  - expected output type
  - acceptance criteria draft
- **Acceptance**:
  - coding, research, review, and planning commands produce different profiles
  - analyzer can run with rules first and model fallback later

### 5.2 Implement Council Proposal Step

- **Goal**: ask selected high-capability agents for solution options.
- **Deliverables**:
  - Chief prompt
  - Shaman prompt
  - optional Scout prompt
  - 2-3 structured proposals
- **Acceptance**:
  - proposals include approach, risks, expected tasks, and validation method
  - proposals are persisted as trace messages

### 5.3 Implement Chief Decision Step

- **Goal**: choose one plan before execution starts.
- **Deliverables**:
  - decision prompt
  - selected plan
  - rejection reasons for alternatives
  - task list
- **Acceptance**:
  - only one plan enters execution
  - decision is persisted as a typed message
  - task list has owner role and acceptance criteria

## Milestone 6: Execution Loop

Goal: execute a simple task graph with bounded autonomy.

### 6.1 Implement Task Dispatch

- **Goal**: assign tasks to agents by role.
- **Deliverables**:
  - pending/running/succeeded/failed task states
  - task owner
  - task result artifact
- **Acceptance**:
  - tasks run in a deterministic order for MVP
  - each task result is traceable
  - failed task can stop the run cleanly

### 6.2 Implement Help Escalation

- **Goal**: make executors ask for advice after repeated failure.
- **Deliverables**:
  - retry counter
  - help request message
  - Shaman or Chief advice response
- **Acceptance**:
  - after configured retry limit, executor asks for help
  - advisor gives guidance rather than taking over execution
  - help interaction is visible in trace

### 6.3 Implement Review Gate

- **Goal**: require acceptance before final report.
- **Deliverables**:
  - review prompt
  - pass/fail result
  - revision request on failure
- **Acceptance**:
  - Chief can accept or reject result
  - final report is produced only after acceptance or explicit failure
  - review result is persisted

## Milestone 7: TUI MVP

Goal: make the runtime usable from a terminal-native interface.

### 7.1 Add Minimal Interactive Shell

- **Goal**: provide the first `totemora` interactive entry.
- **Deliverables**:
  - command input area
  - current tribe summary
  - current run summary
  - live message stream
- **Acceptance**:
  - user can start a run from TUI
  - user can see selected roles and task progress
  - user can interrupt a run

### 7.2 Add Run Command

- **Goal**: support direct one-shot command usage.
- **Deliverables**:
  - `totemora run "<goal>"`
  - final report output
  - run id output
- **Acceptance**:
  - command returns non-zero on failed run
  - command prints where to inspect trace
  - command works without launching full-screen UI

### 7.3 Add Human Approval Points

- **Goal**: prevent unsafe or expensive actions from running silently.
- **Deliverables**:
  - approval for shell/file edit tools
  - approval for expensive provider calls when configured
  - run cancellation
- **Acceptance**:
  - user can approve, reject, or cancel
  - rejected action is captured in trace

## Milestone 8: Web Observatory

Goal: visualize runs after the TUI workflow is usable.

### 8.1 Add Trace API

- **Goal**: expose local run data through a small API.
- **Deliverables**:
  - list runs
  - get run summary
  - get messages
  - get provider calls
- **Acceptance**:
  - API is read-only for MVP
  - failed runs and partial traces are visible

### 8.2 Add Run Detail Page

- **Goal**: show one run's collaboration process.
- **Deliverables**:
  - role assignments
  - task timeline
  - message timeline
  - final report
  - cost and latency summary
- **Acceptance**:
  - TUI can print a URL for a run
  - user can understand who decided, who executed, and why the run passed or failed

## Suggested Order

```text
0.1 -> 0.2
1.1 -> 1.2 -> 1.3
2.1 -> 2.2 -> 2.3
3.1 -> 3.2 -> 3.3
4.1 -> 4.2 -> 4.3
5.1 -> 5.2 -> 5.3
6.1 -> 6.2 -> 6.3
7.1 -> 7.2 -> 7.3
8.1 -> 8.2
```

## Release Criteria

The MVP can be tagged when:

- a user can configure at least two agents from different providers
- `totemora run "<goal>"` completes one council-planned run
- Chief, Shaman, and Warrior roles are selected automatically
- the run records proposals, decision, tasks, messages, provider calls, review, and final report
- failed runs are inspectable from TUI commands
- Web Observatory can open a run and show the collaboration timeline

