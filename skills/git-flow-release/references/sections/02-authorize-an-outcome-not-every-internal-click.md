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
