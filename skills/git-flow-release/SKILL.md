---
name: git-flow-release
description: Coordinate Git commit, push, pull request, merge, branch synchronization, and release workflows on GitHub or Gitea while respecting the repository's branch model and the user's authorized stopping point. Use when the user explicitly asks for Git submission, PR, merge, mainline cleanup, release, branch-strategy migration, or synchronization; do not use for ordinary code changes with no requested Git operation.
---

# Git Flow Release

Coordinate repository state transitions; do not teach Git from first principles. Assume the agent can
choose ordinary commands. Preserve permission boundaries, branch invariants, and provider-specific
fallbacks that prevent irreversible or mis-scoped actions.

When Totemora's `git.flow` specialist invokes this Skill, also read
[the Totemora plan contract](references/totemora-plan-contract.md). Other hosts can ignore that adapter.

## Authorize an outcome, not every internal click

Resolve the user's requested endpoint once:

- **Inspect or organize:** read-only Git checks; no commit or external mutation.
- **Commit / 提交:** create a short-lived branch when needed, validate, stage explicit files, and
  create local commit(s). Stop before Push.
- **Open PR / 提 PR / 提交到 PR:** complete the Commit work, push the short-lived branch, create or
  reconcile the Issue/PR, publish the proportional review, and stop before Merge.
- **Merge / 合并 / 推进到 main / 收回主线 / 完整提交:** complete the Commit and PR work, merge the
  reviewed PR, remove the merged short-lived branch, and synchronize the local stable branch.
- **Release / 发布 / 更新版本:** complete only the named code, version, tag, artifact, image, or
  deployment endpoint. Deployment remains a separate explicit scope unless the user names it.

The selected endpoint is one workflow authorization for all required internal stages. Once the user
has approved the exact plan or clearly requested that endpoint, continue through its Commit, Push,
PR, review, Merge, cleanup, and synchronization steps without repeatedly asking whether to perform
the next ordinary step.

Ask again only when the requested endpoint expands, the reviewed files/Commit message/target branch
materially change, or a hard stop below requires a new decision. A tool or platform may still require
one native approval for the bundled external mutation; do not manufacture additional conversational
gates around it.

## Invariants

- Current user instructions and repository rules override generic conventions.
- Never develop on or push feature work directly to `main`/`master`.
- Preserve unrelated workspace changes; stage explicit paths rather than the whole dirty tree.
- Use Conventional Commits. Keep type/scope in English; follow repository language for the subject.
- Do not force-push, delete a branch with unique work, bypass protection, or invent credentials.
- Code merge, version release, image build, and deployment are separate outcomes and must be reported
  separately.
- Read actual repository workflows before acting on CI, release, or deployment.

## Select the branch model once

Use this precedence:

1. An explicit rule in `AGENTS.md`, `CONTRIBUTING.md`, or equivalent.
2. An active remote `develop` or `dev` used by current PR or release workflows.
3. Otherwise, mainline mode.

Do not create `dev` or `develop` from a generic example, and do not treat a stale branch as policy.

### Mainline mode

`main` is the only long-lived branch. Start `feat/*`, `fix/*`, or `chore/*` from the latest
`main`; merge its PR directly into `main`; delete the merged short-lived branch; then leave the
working repository on a clean, synchronized `main`.

### Legacy development-branch mode

Create short-lived branches from the discovered development branch and merge feature PRs back into
it. Use a separate development-to-`main` PR only for the repository's business release. After that
release reaches `main`, fast-forward the development branch to the final `main` once.

## Preflight and proportional review

Perform one bounded preflight before the first mutation:

- current branch and dirty state;
- remote provider and branch model;
- candidate SHA, target-base SHA, and divergence;
- open PRs for the same head/base;
- actual CI/release configuration relevant to the requested scope.

Use the review depth selected by the current user or repository. Git flow does not require a
particular review Skill. Never ignore concrete blockers involving credentials, destructive data or
migrations, authorization, incompatible contracts, failed required checks, or material deployment
risk.

Record candidate/base SHAs and checks. If both remain unchanged at submission time, reuse the result;
do not repeat architecture inspection, tests, builds, or reviews. If the candidate changes, review
its delta. If the target base advances, inspect the integration delta and run proportional checks.
Publish the completed review at most once unless a later material delta requires an update.

## Execute the authorized path

### Mainline change

1. Ensure work is on a short-lived branch based on current `origin/main`.
2. Commit only intended changes in independently useful batches.
3. For a PR or Merge endpoint, push and create or reconcile one PR into `main`.
4. Confirm the PR still points at the reviewed candidate/base and required checks permit the selected
   merge method.
5. For a Merge endpoint, merge, confirm the merge SHA, remove the short-lived branch, fetch/prune,
   switch to local `main`, and fast-forward it to `origin/main`.

### Legacy change

Use the same feature-branch path, targeting the active development branch. A normal Merge endpoint
stops after that feature PR unless the user also requests the business release into `main`. After a
release PR, synchronize the development branch once rather than manufacturing a reverse PR.

### Release

Run release stages only for explicit release/update scope:

1. Confirm a real releasable change exists; never create an empty trigger commit.
2. Identify the workflow that owns versions, tags/releases, images, and deployment.
3. Follow exact PR, run, and SHA relationships; do not infer success from a similarly named run.
4. Never duplicate a dispatch already owned by repository automation.
5. For trigger-only publishing, stop once the exact run exists and report “release in progress.”
   Report completion only when the requested artifact or deployment has succeeded.

If the repository has no declared release mechanism, report that fact rather than inventing one.

## Command routing

Use native authenticated provider tools when they directly cover the operation. Otherwise use the
installed authenticated CLI. Read [references/commands.md](references/commands.md) only when:

- exact GitHub/Gitea syntax or tool mapping is unclear;
- the native tool does not cover the required action;
- the first provider-specific attempt fails because of authentication or command-version mismatch;
- multiline PR/comment Markdown must be passed safely.

Do not load the command reference for ordinary Git operations whose syntax is already known. For
Gitea multiline Markdown, reuse `scripts/tea_markdown.py` instead of rebuilding shell escaping.

## Mainline migration

Migrate a legacy repository only when explicitly requested. Before deleting `dev`/`develop`, prove
that it has no unique commits, no open PR targets, is not the default branch, and is no longer
referenced by release automation. Declare the new model in repository instructions, migrate through
the existing protected workflow, then delete obsolete branches and verify local/remote alignment.

## Completion contract

Report the authorized endpoint, active branch, local/remote relationship, Commit or PR URL, checks
reused or run, branches removed or preserved, and release/deployment state.

For a completed mainline Merge, all of these must be true:

- the PR is merged and its merge SHA is known;
- the remote short-lived branch is absent unless explicitly preserved;
- the active local branch is `main`;
- local `HEAD` equals `origin/main`;
- the working tree is clean.

If Merge was not authorized, say that the candidate remains on a short-lived branch and that `main`
has not changed.

## Hard stops

Stop before the risky stage for merge conflicts, stale approval snapshots, unknown external mutation
outcomes that cannot be reconciled, missing credentials, required force-push, unrelated commits on
the target, unique work on a branch scheduled for deletion, failed required checks, ambiguous release
ownership, or material production/data/security risk. Report the exact blocker and last completed
safe stage.

After a retryable failure, reuse the original workflow authorization only when its endpoint, snapshot,
Commit message, files, and target branch still match. Do not ask for the same permission again; do not
silently replay an external mutation whose result is unknown.
