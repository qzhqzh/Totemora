# Agent governance policy

- A Skill provides procedural guidance. It does not grant tools, Secrets, repository mutation, or external publishing rights.
- Generic Runs are read-only by default.
- Git mutation, notification, publication, and deployment require a dedicated service, an allowed Asset, an idempotency record, and the applicable approval gate.
- Web, MCP, TUI, Telegram, Cron, and Webhook adapters share the Gateway runtime and may not own a second state machine.
- Operator Tokens and complete device keys must not appear in logs or ordinary API responses.
