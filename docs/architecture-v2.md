# Totemora Architecture v2

Totemora 是预算约束下的异构智能组织系统。当前领域模型与下一阶段边界如下。

```text
Tribe
├─ Members
│  └─ Ember + Persona + Skill Bindings + Asset Grants + Profile + History
├─ Embers
│  └─ Provider + Base Model + Availability + Model Evidence
├─ Skills
│  └─ Commission + Package + Version + Evaluation + Binding
├─ Assets
│  └─ Asset Card + Blueprint + Verified Experience
├─ Specialist Services
│  └─ Definition + Binding + Durable Task + Domain State Machine
├─ Missions / Runs
│  └─ Goal + Staffing + Work Results + Review + Trace
└─ Governance
   └─ Budget + Acceptance + Proposal + Approval + Version History
```

An **Ember（火种）** is a callable base model capability. A member is created when an Ember is combined with persona, Skills, tools, experience, trust and a version. One Ember may seed multiple members with different specializations. During bootstrap, the Ember catalog is projected from provider and member configuration; later it owns model-level price, context, benchmark and availability evidence independently from member performance.

## Current runtime loops

```text
One-shot inspect task
  -> Task Analyzer + budget
  -> Chief staffing + bounded work packages
  -> member execution + independent review when required
  -> acceptance + immutable Run evidence

Always-on specialist task
  -> typed service contract + durable task
  -> Chief binding / specialist
  -> service-owned state machine + governed assets
  -> self-check / Chief acceptance / external gate
  -> result + experience + observable evidence
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

The generic Run path remains deliberately read-only. Write operations are only available through explicit specialist services, Workplace Policy, asset grants and approval gates; a natural-language goal never implies arbitrary Shell or filesystem authority.

## Current interaction boundary

```text
Generic CLI Run ────────────────> TribeRuntime + FileRunStore (transitional)

Web / MCP / Telegram / Cron / Gateway CLI
                 │
                 ▼
       Authorization + Intake Adapter
                 │
                 ▼
          Persistent Gateway
     ├─ TribeRuntime / Missions / Runs
     ├─ Specialist services / durable tasks
     ├─ Member state / Skill governance
     └─ Provider adapters / governed assets
```

Web、MCP、Telegram、Bark、Cron 与 CLI Run 共享同一个常驻 Gateway，不拥有第二套 Runtime。显式 `--offline` 只用于本地兼容和测试，不写入 Gateway SQLite。Gateway 默认只监听 loopback；局域网访问必须显式配置 host。

## Member portrait and recurring work

```text
Verified task evidence -> observed portrait + task record + major experiences
                      -> review threshold -> mentor proposal -> operator approval -> constitution vN+1

10-minute scan -> scored/deduplicated candidate pool -> one-per-minute multi-channel dispatcher -> action evidence

high-confidence candidate -> researcher brief -> distinct writer draft -> independent collaborator review -> copy-ready content -> user adoption evidence
```

Descriptive portrait fields may update automatically from evidence. Normative personality changes are versioned proposals; protected principles, red lines and permissions never evolve silently.

## Asset boundary

An asset is discoverable knowledge, software or infrastructure that may help a member. Discovery does not install it. Official documentation becomes a blueprint; only evidence from a traceable tribe run becomes tribe experience.

## Skill governance target

```text
User conversation -> Skill Commission -> normalized package -> validation -> bounded trial
                                                        -> activation proposal -> member/service binding
                                                        -> outcome observation -> revise / rollback
```

用户将通过对话委任能力，部落负责文件生成和维护。Skill 包含程序性指导，Asset 提供可执行能力，Specialist Service 提供稳定的长期契约。激活 Skill 不会静默授予资产、Secret、外部副作用、人格变更或新模型。

`SKILL.md` 遵循可移植的 Skill 结构；Totemora 特有的生命周期、风险、证据和绑定元数据放在 `skill.yaml`。Git 专业任务和自动试炼已经固定实际加载的版本、Commission 与包 digest；其他专业服务仍需逐个接入同一证据契约。参见 [Skill 对话治理](skill-governance.md) 和 [ADR-0016](adr/0016-conversational-skill-governance.md)。
