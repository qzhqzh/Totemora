## Command routing

Use native authenticated provider tools when they directly cover the operation. Otherwise use the
installed authenticated CLI. Read [references/commands.md](../../references/commands.md) only when:

- exact GitHub/Gitea syntax or tool mapping is unclear;
- the native tool does not cover the required action;
- the first provider-specific attempt fails because of authentication or command-version mismatch;
- multiline PR/comment Markdown must be passed safely.

Do not load the command reference for ordinary Git operations whose syntax is already known. For
Gitea multiline Markdown, reuse `scripts/tea_markdown.py` instead of rebuilding shell escaping.
