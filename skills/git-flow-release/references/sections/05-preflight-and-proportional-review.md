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
