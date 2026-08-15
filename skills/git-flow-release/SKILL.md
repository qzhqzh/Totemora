---
name: git-flow-release
description: Govern existing repository changes with the user's git-flow-release rules while preserving Totemora's approval boundaries. In the current Totemora adapter, use for local commits and GitHub Pull Request or merge plans; treat Gitea publishing, releases, branch synchronization, cleanup, and deployment as guidance-only until a deterministic executor is available.
---

# Git Flow Release

> Totemora 内部标识与用户维护的 Skill 统一为 `git-flow-release`。
> 当本 Skill 由 Totemora `git.flow` 专员调用时，必须同时读取并遵守
> [Totemora 计划输出契约](references/totemora-plan-contract.md)，以便确定性执行引擎验收计划。

Use the repository's declared branch model. Keep PR review, branch protection, versioning, and
deployment as separate safety boundaries even when the repository has only one long-lived branch.

## Core rules

- Never develop or push directly on `main`/`master`.
- Preserve unrelated workspace changes.
- Use Conventional Commits and one independently reviewable PR per repository.
- Treat commit, push, PR creation, merge, version release, and deployment as distinct permissions
  unless the user explicitly authorizes the full flow.
- Read repository instructions and actual CI/release workflows before acting.

## Determine the branch model

Resolve the model once before creating a branch:

1. An explicit repository rule in `AGENTS.md` or equivalent wins.
2. Without an explicit rule, an existing remote `develop` or `dev` indicates the legacy
   development-branch model.
3. Without either development branch, use mainline mode.

Do not create `dev` or `develop` merely because a generic workflow mentions it. Do not treat a
stale branch as active when the repository explicitly declares mainline mode.

### Mainline mode

- `main` is the only long-lived branch.
- Create `feat/*`, `fix/*`, or `chore/*` from the latest `main`.
- Open the feature PR directly into `main`.
- After merge, remove the short-lived branch. Do not create a second release PR or synchronize a
  development branch.

### Development-branch mode

- Discover the actual development branch; do not assume its name.
- Create short-lived branches from it and merge feature PRs back into it.
- Use a separate PR from the development branch into `main` for the business release.
- After the final release state is on `main`, fast-forward the development branch to `main` once.

## Review before merge

Use the `code-review` skill to classify the final diff as lightweight, standard, or high-risk.
Review lightweight and standard changes directly in the main agent. Use parallel reviewers only
for high-risk changes or an explicitly requested deep review.

Complete proportional tests and review when each functional change finishes, before it is treated
as merge-ready. Keep the review record scoped by function:

- For later changes within the same function, test and review only the delta, then append the
  result to that function's existing review record.
- Treat a materially distinct new function as a new review unit with its own scope, checks,
  findings, and conclusion, even when it is added to an existing active PR.
- Keep different functions visibly separated in the PR review so one passing conclusion cannot
  implicitly cover unrelated later work.

Run focused regression checks. Run a broad suite only when repository rules or the integration
surface justify it. Record:

- review tier;
- candidate SHA;
- target-branch base SHA;
- completed checks.

If both SHAs remain unchanged, reuse the review during publishing. If the candidate changes,
review only its delta. If the target base advances, inspect the integration delta and run
proportional checks. Reclassify only when the delta introduces materially different risk.

## Interpret release words

- `提交`: create only the explicitly authorized local commit. It does not authorize Push, Issue,
  Pull Request, Merge, release, or deployment.
- `Push`、`创建 Issue`、`创建 PR`、`合并 PR`: each authorizes only the named remote side effect.
- `更新` or `发布`: do not infer the complete release chain. Identify the required Commit, Push,
  PR, Merge, version/tag/release, image, and deployment stages, then execute only stages explicitly
  authorized by the user and repository policy.
- `完整提交并发布` or an equally explicit full-flow instruction can authorize the named stages as
  one workflow, but deployment still requires separate explicit authorization.
- If reviewed code is already on `main`, report that fact and request/verify authorization for the
  remaining version, tag, image, or deployment stage instead of manufacturing another code PR.

Report `代码已合并到 main` separately from `镜像构建已触发/完成`.

## Fast-path classification

Classify each repository once:

- `candidate-ready`: candidate SHA and reviewed target-base SHA are unchanged and checks passed;
- `needs-review`: candidate or integration base changed, or no review exists;
- `main-ready`: reviewed code is already on `main`;
- `no-release`: no releasable commit exists after the last component version.

For `candidate-ready`, run one status/base check and only missing checks. Do not repeat architecture
inspection, review, tests, or a local production build. For `main-ready`, skip code PR creation.

Before `更新/发布`, confirm a real releasable Conventional Commit exists (`feat`, `fix`, `perf`,
or breaking). Do not use empty trigger commits. Classify a real user-visible correction as `fix`
when accurate.

## Mainline publish workflow

Use this workflow only when the user has explicitly authorized every required Commit, Push, Pull
Request, and Merge stage. Stop at the last authorized stage.

1. Verify the candidate and target-base SHAs.
2. Commit and push the short-lived branch.
3. Create a PR directly into `main` and publish the completed review once.
4. Merge the PR and delete the feature branch.
5. After an explicitly authorized Merge, update local `main`, verify it matches `origin/main`, and stop.
6. For `更新/发布`, identify the feature-merge push run, wait only for that exact run, then query
   the newest matching version PR.
7. Verify and merge the expected release-please version PR.
8. Confirm tag/release and the production image workflow dispatched for the release SHA. Report
   completion only after the image is successfully pushed; if the user requested trigger-only
   publishing, stop as soon as the dispatch exists and report release in progress.

## Development-branch publish workflow

Use this workflow only when the user has explicitly authorized every required Commit, Push, Pull
Request, and Merge stage. Stop at the last authorized stage.

1. Verify the candidate and target-base SHAs.
2. Commit/push the feature branch, open its PR into the development branch, and publish review.
3. Merge the feature PR and update the local development branch.
4. Open and merge the development-branch PR into `main`, referencing the feature PR review.
5. After an explicitly authorized Merge, fast-forward development to `main`, verify alignment, and stop.
6. For `更新/发布`, process the version PR/tag/image first, then synchronize development to the
   final `main` once.

## Publish the review

Post one review on the feature PR:

```markdown
## Code Review

### Standards
- Findings or `No blocking findings`.

### Spec
- Findings or `Implementation matches the agreed scope`.

### Specialist supplement
- Only for triggered high-risk topics.

### Verification
- Commands and results.

**Conclusion:** pass/block; review tier; finding counts; candidate/base SHAs.
```

Fix blockers before posting a passing conclusion. Review only the fix delta. In legacy mode, the
release PR references this review instead of duplicating it.

When a PR contains more than one reviewed function, repeat the review sections per function or add
clearly titled incremental review comments. Publishing reuses these completed records and reviews
only changes made after the last recorded candidate SHA.

## Submission latency budget

Keep submission and publishing work staged so release time is coordination, not a second development
cycle:

1. At functional completion, run focused tests and complete the proportional review immediately.
   Fix findings then, not after the user says `更新/发布`.
2. Record the reviewed candidate SHA, target-base SHA, checks, and review conclusion in the PR or
   current task. Later edits to the same function require only delta checks; distinct functions get
   separate review records.
3. At submission time, do one preflight per repository: dirty state, current branch, candidate SHA,
   target-base SHA, and remote divergence. If these match the record, do not reread architecture,
   rerun unchanged tests, or repeat review.
4. Run independent repositories in parallel at each stage: preflight, push, feature PR, merge,
   version PR, and dispatch confirmation. Preserve ordering only inside each repository.
5. Do not run local production image builds during a normal remote release. After merging the version
   PR, confirm the matching `workflow_dispatch` run once and stop when the user accepts trigger-only
   publishing.

### Trigger-only hard stop

Treat trigger-only publishing as an event-confirmation workflow, not a build-monitoring workflow:

1. Read the repository release workflow once and identify which workflow owns image dispatch. If the
   release workflow dispatches the image workflow, never send a second manual dispatch.
2. After the feature merge, query only the exact release run for that merge SHA. When it succeeds,
   inspect only the newest open version PR needed to verify and merge the expected release.
3. After the version PR merge, query image runs with the exact workflow, event, and release merge SHA;
   keep the result set small. The first matching queued/running/completed run proves dispatch.
4. Stop immediately after that proof when trigger-only publishing is accepted. Do not wait for image
   completion, inspect jobs/logs, query tags/releases, repeat fetch/pull, or synchronize local `main`
   unless a concrete failure makes one of those actions necessary.
5. Manually dispatch only when the declared owner workflow completed successfully, no matching image
   run exists after one bounded follow-up query, and repository rules explicitly permit recovery.

Use one preflight, one exact release-run lookup, and one exact image-dispatch lookup as the normal
remote query budget. Broader history queries and repeated polling require a concrete ambiguity or
failure, not general caution.

For a reviewed single-repository hotfix, target 3-5 minutes to image dispatch. For two independent
repositories, target 5-8 minutes. Exceeding the target should be explained by an actual finding,
failed check, remote conflict, or CI delay rather than repeated safety work.

## Preserve Markdown formatting

PR descriptions and comments must contain real newline characters. Never pass visible `\\n`, use
`JSON.stringify` output, or interpolate Markdown through a shell command where backticks and
`$()` can execute.

Use the bundled helper with a single-quoted heredoc:

```bash
python <totemora-root>/skills/git-flow-release/scripts/tea_markdown.py \
  comment --repo owner/repo --pr 123 <<'MARKDOWN'
## Code Review

### Standards
- No blocking findings.
MARKDOWN
```

Use `create-pr` with `--head`, `--base`, and `--title` for PR descriptions. Read the created PR or
comment back once. Visible `\\n`, collapsed headings/lists, or shell-expanded content is a
publication defect that must be fixed before merge.

For automation, prefer `--body-file` over interactive stdin:

```bash
mkdir -p /tmp/totemora-git-flow
# Write the body with the available file editing tool, then keep it owner-controlled.
chmod 600 /tmp/totemora-git-flow/pr-body.md
python <totemora-root>/skills/git-flow-release/scripts/tea_markdown.py \
  --body-file /tmp/totemora-git-flow/pr-body.md \
  create-pr --repo owner/repo --head fix/example --base main \
  --title "fix: example"
```

Create the body file with the editing tool available in the current environment. Never start the
helper without a body, and never retry a failed body submission through an interactive PTY.

## Migrate a repository to mainline

Migrate incrementally per repository:

1. Confirm `main` and every active development branch contain the same commits and no open PR
   still targets the development branch.
2. Confirm merging to `main` does not unintentionally bypass or trigger an unsafe legacy release.
3. Declare mainline mode in repository instructions and update developer documentation.
4. Remove CI scripts that push `main` into `dev`/`develop`.
5. Merge these changes through the repository's currently active workflow.
6. Delete remote `dev`/`develop` only after the migration PR reaches `main` and rechecking
   alignment/open PRs.
7. Switch local tracking to `main` and verify no workflow/config still references the removed
   branch.

Do not delete a development branch with unique commits, open target PRs, or unresolved release
dependencies.

## Gitea and timing notes

- Put `tea pr merge` options before the PR number.
- Use the broadly compatible merge form `tea pr merge --repo <owner/repo> --style merge <number>`.
  Do not pass `--delete`: some deployed `tea` versions reject it. Gitea commonly deletes the head
  branch automatically; after merge, run `git fetch --prune` and only issue an explicit remote delete
  when the ref still exists.
- Parallelize independent repositories and same-stage operations; preserve order inside each repo.
- Query exact action run/job state by run ID or release SHA instead of fixed sleeps.
- Query only open PRs or the newest expected release PR. Do not fetch full PR history merely to
  discover the current version PR.
- Use one bounded wait followed by one exact query. If automation is still running, use short,
  bounded follow-up checks; never use an unbounded poll loop.
- Do not call `--help` during a normal release when the compatible command is documented here.
- Do not rerun unchanged review or checks during publishing. Reuse recorded candidate/base SHAs.
- For trigger-only publishing, stop when the release SHA has a `workflow_dispatch` image run;
  do not wait for image completion or perform optional local synchronization.
- Inspect a failed completed job log before speculative corrective commits.
- A dispatched image means `发布进行中`; only a successfully pushed production image means release
  completion.

## Stop conditions

Stop for destructive/unauthorized migrations, unrelated commits entering the target branch,
merge conflicts, unique commits on a branch scheduled for deletion, material production risk, or
missing permission. For `tumor_api`, database migrations remain user-operated unless explicitly
authorized for the current task.
