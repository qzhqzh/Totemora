## Mainline migration

Migrate a legacy repository only when explicitly requested. Before deleting `dev`/`develop`, prove
that it has no unique commits, no open PR targets, is not the default branch, and is no longer
referenced by release automation. Declare the new model in repository instructions, migrate through
the existing protected workflow, then delete obsolete branches and verify local/remote alignment.
