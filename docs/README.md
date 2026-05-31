# Totemora Design

Totemora is a terminal-native multi-agent tribe runtime with a web observability console.

Its core idea is not a fixed `planner -> executor -> reviewer` chain. Totemora treats different AI models as tribe members, selects them into temporary roles for each run, and records how they plan, delegate, ask for help, execute, review, and improve the tribe manual.

## Product Positioning

Totemora has three product surfaces:

- **TUI Control Plane**: the main user entry. Users create tribes, configure AI providers, start tasks, approve actions, and inspect live progress from the terminal.
- **Runtime Core**: the multi-agent orchestration engine. It handles election, council planning, task dispatch, structured messaging, help escalation, review, and trace recording.
- **Web Observatory**: a read-heavy console for traces, role graphs, task timelines, cost, latency, and tribe manual review.

The first product should be TUI-first. The web UI is important, but mainly for observability and replay.

## Core Concepts

### Provider

A provider is a model API integration, such as OpenAI, Qwen, Kimi, GLM, Claude, Gemini, or a local model.

The tribe runtime should not depend on provider-specific APIs. Providers are hidden behind adapters.

### Agent

An agent is a tribe member created from a provider model plus a capability profile, tool permissions, and historical performance.

The tribe collaborates through agents, not raw models.

### Role

A role is a temporary responsibility assigned during one run.

Initial roles:

- **Chief**: final decision maker and acceptance owner.
- **Shaman**: advisor that gives strategy, risks, and alternatives.
- **Warrior**: high-skill executor for hard implementation or reasoning work.
- **Worker**: low-cost executor for routine work, checks, formatting, transfer, and summarization.
- **Scout**: researcher that reads docs, searches context, and gathers evidence.
- **Reviewer**: validates output against the acceptance criteria.

Roles are not static identities. The same agent may become Chief in one run and Shaman in another.

### Run

A run is one user task from command input to final acceptance.

A run contains:

- user goal
- selected tribe
- elected roles
- council proposals
- chief decision
- task graph
- structured messages
- tool calls
- artifacts
- review result
- trace and cost data
- optional manual entries

### Tribe Manual

The tribe manual stores reusable experience learned from previous runs.

Manual entries should be proposed by agents and accepted by the Chief or the user before becoming active rules. Totemora should not silently mutate its operating rules in early versions.

## Runtime Flow

```text
User Command
  -> Task Analyzer
  -> Agent Registry
  -> Election Engine
  -> Tribal Council
  -> Chief Decision
  -> Task Dispatcher
  -> Execution Loop
  -> Help Escalation
  -> Review Gate
  -> Final Report
  -> Manual Proposal
```

## Design Principles

- **TUI-first**: terminal is the primary control surface for developer workflows.
- **Provider-agnostic**: Kimi, Qwen, GLM, GPT, Claude, and local models are provider adapters, not orchestration concepts.
- **Structured messages over free chat**: agents communicate through typed events, not unconstrained conversations.
- **Trace everything**: every election, decision, task, message, tool call, and review result should be observable.
- **Bounded autonomy**: agents may propose new rules, but early Totemora requires acceptance before applying them.
- **Minimal first version**: start with config files and local runtime, then add richer management UI after behavior stabilizes.

## Suggested Package Layout

```text
packages/core        tribe runtime, roles, election, task dispatch
packages/providers   provider adapters
packages/tui         terminal control plane
packages/server      API and trace server
packages/web         observability console
configs              local tribe/provider/agent config
docs                 design documents
```
