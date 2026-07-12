# Totemora Architecture v2

Totemora 是预算约束下的异构智能组织系统。首个闭环由四类核心领域对象构成。

```text
Tribe
├─ Members
│  └─ Ember + Persona + Skills + Tools + Profile + History
├─ Embers
│  └─ Provider + Base Model + Availability + Model Evidence
├─ Assets
│  └─ Asset Card + Blueprint + Verified Experience
├─ Runs
│  └─ Goal + Staffing Plan + Work Results + Review + Trace
└─ Governance
   └─ Budget + Acceptance + Promotion + Approval + Rollback
```

An **Ember（火种）** is a callable base model capability. A member is created when an Ember is combined with persona, Skills, tools, experience, trust and a version. One Ember may seed multiple members with different specializations. During bootstrap, the Ember catalog is projected from provider and member configuration; later it owns model-level price, context, benchmark and availability evidence independently from member performance.

## First runnable loop

```text
User starts onboarding exam run
  -> configured Chief reads roster and acceptance criteria
  -> Chief creates structured assignments
  -> DeepSeek / Qwen / MiMo members work in parallel
  -> Chief reviews results and emits exactly three questions
  -> Runtime validates and stores the complete run
```

The runtime owns member identity, staffing, growth and governance. Provider integrations only normalize model calls. AG-UI, A2A, MCP and OpenTelemetry may be adopted at the boundaries without replacing the domain model.

## Generic read-only task loop

```text
User goal + acceptance criteria + workspace path
  -> bounded secret-safe WorkspaceSnapshot
  -> Chief staffing plan
  -> member evidence collection in parallel
  -> Chief evidence report and acceptance review
  -> local structured Run trace
```

The initial generic runtime is deliberately read-only. Write tools, shell execution and approval gates must be added as explicit capabilities rather than inferred from a natural-language goal.

## Current interaction boundary

```text
CLI -------------------┐
                       ├─> TribeRuntime -> Provider adapters -> Run trace
Local Web Playground --┘
```

The Web Playground is an experience and test surface, not a separate orchestration engine. It exposes the roster, task input, live job phase, staffing evidence, final report and trace. The local server binds to loopback by default, keeps transient job state in memory and persists completed runtime traces through the same `FileRunStore` used by the CLI.

## Asset boundary

An asset is discoverable knowledge, software or infrastructure that may help a member. Discovery does not install it. Official documentation becomes a blueprint; only evidence from a traceable tribe run becomes tribe experience.
