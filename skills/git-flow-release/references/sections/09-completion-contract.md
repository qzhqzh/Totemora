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
