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
