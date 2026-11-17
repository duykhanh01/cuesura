# Supervision and recovery

## Waits and wake-ups

Use the harness's completion event or PR watch; a tracked background command is an alternative only
when its completion is guaranteed to wake this lead and local rules permit it. A timed fallback is
useful only when supported. Do not poll forbidden status endpoints, invent sleeping watchers or
assume a later event will arrive. Record the actual continuation in Next before waiting. A watcher
message, including an ambiguous count of passes, triggers a fresh read of real checks.

On wake reconcile every relevant live worker/PR, not just the notice's subject. Duplicated or lost
notices must not duplicate dispatches. Advance all evidenced steps to the next real wait. An idle
worker with incomplete output needs a continuation, not an accepted DONE. Compare status with
activity/commits before declaring a worker stuck; elapsed time alone is diagnostic. Two unproductive
nudges call for diagnosis, context repair or authorized replacement, not automatic model escalation.

After lost context/session/worktree, read ledger, reports, PR state and Git refs through permitted
mechanisms before resuming. Missing agent/worktree does not mean missing work. Preserve Phase while
blocked; record evidence, unblock condition and exact continuation. Read archived outcomes for
dependencies; accepted/handed-off is not merged. Verify paths exist before asking a resumed agent
to use them. Preserve uncommitted/untracked work before reconstruction or cleanup.

## CI verdicts

Use one authoritative classification, including external statuses:

```bash
bash /absolute/skill-dir/scripts/pr-ci.sh <pr> --policy /absolute/run/ci-policy.json
```

Policy is a reviewed run artifact based on required checks, existing workflows, path/draft rules
and known external services. It must enumerate every expected context for this change; the helper
cannot infer path-filter semantics or branch protection completeness. Example:

```json
{"expected":["validate","secrets"],"allow_skipped":[]}
```

`expected` is nonempty. `allow_skipped` lists named contexts whose skip is legitimate for this
change (for example docs-only jobs behind an always-present aggregate gate). Never allow a missing
context by calling it skipped. Include required and relevant nonrequired jobs and external contexts;
all observed failures/cancellations veto green even if absent from expected. Resolve ambiguous or
duplicate context names before using the helper. Do not change the policy to hide a failure.

The helper requests `filter=latest` check runs and GitHub's combined current status for the exact
head. If names still collide, it returns ERROR with source, app ID, check-run ID and link where
available. Inspect those records on that SHA: distinguish reruns from separate apps or jobs. Never
choose a passing record merely because it is newer or remove a failing app. Rename colliding job
names at their source when authorized, then rerun and update the reviewed policy to those names.
If the sources cannot be distinguished or changed within scope, record the blocker and hand back;
this helper cannot establish GREEN from ambiguous names.

| Verdict | Action |
| --- | --- |
| GREEN | exact full head has complete passing/explicitly allowed skipped checks; apply remaining merge gates |
| RED | read failures, including external checks; fix or route to their owner, never merge red |
| PENDING | checks running, or head changed while reading; use the supported wake |
| NO_RUN | checks absent/incomplete or skips not approved; diagnose triggers, filters, permissions and conflicts |
| ERROR | API/JSON/policy error; repair access/query, never interpret as no checks or green |
| DRAFT | finish review and settle pushes before ready; CI that skips drafts runs after ready |
| DIRTY | coordinate conflict resolution and seam review |
| MERGED / CLOSED | reconcile state; investigate unexpected closure |

Exit codes: 0 GREEN/MERGED, 1 RED, 2 NO_RUN/DIRTY/DRAFT/CLOSED, 3 PENDING, 4 ERROR.
`--wait [minutes]` is optional only where blocking/polling is permitted; T3 uses its PR watcher
instead. `PR_CI_CLASSIFY_ONLY=1` accepts checks JSON on stdin for offline classification with the
same policy. The helper reads full head before and after checks; merge with that exact SHA using
`gh pr merge --match-head-commit <full-sha>`. A later push invalidates the verdict.

NO_RUN needs a diagnosed cause before a retrigger; never toggle draft/ready repeatedly. Let the
last push settle before ready: racing those events can cancel the one eligible run. A known flake
needs evidence and a bounded failed-job rerun, not a green assertion. Persisting failure needs a
fix. External services can block merge even when remediation is outside the coder's scope.

## Base and Git

Record the verified base checkpoint alongside the green head. Fetch; compare changes on base from
that checkpoint to the current base, rather than diffing PR head against base (which counts the
PR's own work). Assess file overlap and related interfaces, not filenames alone:

```bash
git fetch origin
git diff --name-only <verified-base-sha>..origin/<base>
```

If shared behavior changed, update the branch, verify resolution, review relevant seams and obtain
current-head green again. Do not pull into a shared checkout owned by a worker. After an ambiguous
merge command failure, read PR state before retrying.

When setting up CI under an explicit grant: workflows on base first, then required checks. Keep
required aggregate checks reporting for docs-only PRs; path-classification failures must not silently
claim docs-only. Follow repo-required local checks before push/report; full suite belongs on CI
where repo policy says so. Evidence already sufficient is reused unless contradicted.

## Handoff and cleanup

Save ledger and a concise current-state handoff before compaction. Reconstruct from current ground,
not historical transcripts. Archive terminal tasks by parent; keep active decision references and
deferred tracking. Release obsolete watchers/wakes, cancel unused workers, and remove workspaces
only when no live worker needs them and all needed files (including untracked work) are preserved.
Pushed alone is insufficient. Leave blocked PRs open with their continuation and authority question;
keep independent work moving. Shared quota exhaustion blocks affected tasks until reset without
silently changing provider/profile/model.
