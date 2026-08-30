# Git command fallback

Read this file only when exact provider syntax is unclear, native tooling does not cover the action,
or the first provider-specific attempt fails. Prefer an authenticated GitHub/Gitea connector over a
CLI, and a CLI over handwritten API requests.

Resolve every placeholder before execution. Never run literal `<branch>`, `<base>`, `<number>`, or
`<owner/repo>` values.

## Detect provider and state

```bash
git remote get-url origin
git status --short --branch
git branch --all --verbose --no-abbrev
git fetch origin --prune
git rev-list --left-right --count origin/<base>...HEAD
git diff --check origin/<base>...HEAD
```

GitHub remotes normally use `github.com`; use a GitHub connector or `gh`. For a configured Gitea
host, use its connector or `tea`. If CLI authentication fails while an authenticated connector is
available, route through the connector instead of requesting another token.

## Common local transitions

```bash
git switch <base>
git merge --ff-only origin/<base>
git switch -c feat/<slug>
git add -- <path> [<path> ...]
git commit -m "feat(scope): concise change"
git push -u origin <branch>
```

Use `fix/*` or `chore/*` when appropriate. Do not use `git add .` in a dirty workspace. Do not
force-push unless the user explicitly authorizes it and repository policy requires it.

## GitHub route

Use native operations equivalent to listing exact head/base PRs, creating the PR, reading mergeability
and checks for the candidate SHA, merging by repository policy, and confirming the merge SHA.

CLI fallback:

```bash
gh auth status
gh pr create --base <base> --head <branch> --title "<title>" --body-file <body-file>
gh pr view <number> --json state,mergeable,headRefOid,baseRefOid,statusCheckRollup,url
gh pr comment <number> --body-file <review-file>
gh pr merge <number> --merge --delete-branch
```

Use `--squash` or `--rebase` only when repository policy selects it.

## Gitea route

Prefer the configured Gitea connector. With `tea`, preserve multiline Markdown through the bundled
helper:

```bash
python <skill-root>/scripts/tea_markdown.py \
  --body-file <body-file> create-pr --repo <owner/repo> \
  --head <branch> --base <base> --title "<title>"

python <skill-root>/scripts/tea_markdown.py \
  --body-file <review-file> comment --repo <owner/repo> --pr <number>

tea pr merge --repo <owner/repo> --style merge <number>
```

Older `tea` versions differ. If the documented compatible form fails because a subcommand is
unsupported, inspect the installed version once and adapt rather than retrying guessed variants.

## Markdown bodies

- Create PR descriptions and review comments as UTF-8 files with real newlines.
- Never pass visible `\\n`, JSON-stringified Markdown, or shell-interpolated content containing
  backticks or `$()`.
- Use `--body-file` for `gh` and `tea_markdown.py --body-file` for `tea`.
- Read the created PR or comment once; malformed Markdown is a publication defect.

## Finish after merge

Only after the PR is confirmed merged:

```bash
git fetch origin --prune
git switch <base>
git merge --ff-only origin/<base>
git push origin --delete <branch>
git branch -d <branch>
git rev-parse HEAD origin/<base>
git status --short --branch
```

Skip remote deletion when the provider already removed the branch. Delete neither a branch with
unique unmerged work nor a branch the user asked to preserve. A squash-merged local branch may need
forced local deletion only after the provider proves the exact PR was merged.

## Release lookups

Release commands are repository-specific. Inspect the actual workflow and query by exact merge or
release SHA. Minimal GitHub fallback:

```bash
gh run list --workflow <workflow> --commit <sha> --limit 5
gh run view <run-id> --json status,conclusion,url,headSha
```

Dispatch only when repository automation declares the owner, the requested endpoint includes it,
and no matching run already exists.

## Failure routing

- Missing authentication: stop before the external mutation and report the exact missing authority.
- Advanced target base: fetch, inspect the integration delta, update by repository policy, and rerun
  proportional checks.
- No common ancestor, required force-push, merge conflict, or unexpected commits: stop; do not
  improvise a destructive recovery.
- Branch protection rejects direct mutation: use the required PR path.
