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
