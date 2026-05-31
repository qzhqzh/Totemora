# Development Guide

This guide describes the current contribution workflow for Totemora.

Totemora uses a GitHub-first workflow:

```text
Issue -> feat/* branch -> implementation + checks -> conventional commit -> PR
```

## Prerequisites

- Bun 1.3.14 or compatible
- Git
- GitHub CLI authenticated with access to `qzhqzh/Totemora`

Check local tools:

```bash
bun --version
gh auth status
```

## Install

Install workspace dependencies from the repository root:

```bash
bun install
```

## Checks

Run all baseline checks before committing:

```bash
bun run lint
bun run typecheck
bun run test
```

The initial checks validate the workspace baseline. They should remain fast and deterministic while the project is still in repository setup.

## Branches

Create one branch per Issue:

```bash
git checkout main
git pull
git checkout -b feat/m0-1-bun-workspace
```

Use branch names that include the execution-plan item when possible:

```text
feat/m0-1-bun-workspace
feat/m1-1-config-types
fix/provider-smoke-error
```

## Commits

Use conventional commit messages:

```text
feat: initialize bun workspace
chore: add repository hygiene files
docs: add development guide
fix: handle missing provider env var
```

For feature work tied to an Issue, include the closing reference in the commit body:

```bash
git commit -m "feat: initialize bun workspace" -m "Closes #3"
```

## Pull Requests

Open one PR per Issue. Keep each PR focused on one behavior or document change.

PR title format:

```text
#<issue-number> <short title>
```

PR description must include:

- what changed
- why it changed
- how it was tested
- linked Issue

Example:

```markdown
## What changed
- Added the root Bun workspace manifest.
- Added placeholder package manifests.

## Why
This implements execution-plan item M0.1.

## How tested
- `bun install`
- `bun run lint`
- `bun run typecheck`
- `bun run test`

Closes #3
```

## Merge Flow

After checking the PR diff and validation output:

```bash
gh pr diff <number> --name-only
gh pr checks <number>
gh pr merge <number> --squash --delete-branch
```

Then sync local `main`:

```bash
git checkout main
git pull
```

## Safety Rules

- Do not commit API keys, tokens, passwords, or local secrets.
- Keep `.env` local; only commit `.env.example`.
- Do not introduce runtime dependencies without explaining why in the PR.
- Do not mix unrelated cleanup into feature PRs.
- Do not build Web Observatory features before trace-producing runtime work exists.
