# Recover a request or unblock a task

Use the connection and mutation rules in [SKILL.md](../SKILL.md). For a wait, start with
`task explain`. If an action has no command, read its note for what needs to happen.

## Recover a request

```sh
cusr request show "$REQUEST_ID" --json
```

- On `daemon_timeout`, `internal`, `store_write_failed`, or any ambiguous outcome, look up the
  original request. If you resend, use the same command, input, version, and request ID. Never
  add a second task because the first add timed out.
- Check `data.state` even when lookup exits 0. `completed` holds the original response in
  `data.outcome`. For `in_progress`, check later. For `interrupted`, follow `data.next_step`
  and retry with the original ID. `request_not_found` can mean the request has yet to arrive.
  Follow `error.details.next_step` and check `task list` before deciding an add did not happen.
  Only the same actor can look up its request.
- A resend can be refused with `store_unwritable`. Keep the request ID while the user
  diagnoses the store with `doctor` or restarts the daemon.
- A definite refusal can warrant a new request. Read `error.details.guidance` and the latest
  state first. On `stale_version`, retry only if the intent still applies. A losing `answer`
  can return `already_answered` without changing the version.
- A refused `task confirm --run-config` can report `details.committed.intake`. The intake was
  confirmed. Read `task show` again and use a new request ID, the current version, and the
  current approved digest to confirm the run settings.

## Unblock the current step

| Wait or failure | What to do |
| --- | --- |
| `worktree_changed` | Show the actual diff and get the user's approval before `task recheck` adopts it and reruns the step. If the diff is unavailable, hand off. |
| `manifest_changed` | Ask the user to verify and approve the replacement harness manifest before `task recheck` adopts it. Current harness setup records the manifest without a model run. |
| `harness_auth` | The user signs in on the daemon host. Recheck once they confirm. |
| Harness `auth_config` or `capability_missing` | Read the specific cause and fix in `task explain` and relay it to the user. |
| `loop_exhausted` with an infrastructure, login, or rate-limit failure | Have the user resolve the cause first. Use recheck if the action is offered to restore the failed visits. |
| A wait with `resume_when` containing `answer(<qid>)` | Answer the question. For base repair, use exactly `continue` after conflicts are resolved or `retry fixer` to request another fixer attempt. |
| `escalation` | The assistant may approve the frozen ladder rung with `task approve --kind escalation`. Copy the step and rung from `task explain`. |

When `continue` is offered, inspect recent review or gate failures before granting more tries with
the same model. Report repeated failures without progress. For a review loop, `task show` exposes the
frozen cap in `review_policy.max_review_rounds`. Editing the workflow limit affects future
snapshots. A task that exhausted a legacy agent-run or deadline limit needs it raised first.

`task amend-policy` previews a model or effort change, an increased agent-run cap, or a later deadline.
Apply it only with the user's approval of the preview. Pass its hash to `--confirm` with a reason and
the current version. If the policy hash changes, preview again.

For daemon connection errors, relay `error.details.guidance`. A missing or refused socket can mean
the daemon is stopped or the data dir is wrong. `EINVAL` can mean the path is too long. `EPERM`
can mean the harness sandbox blocks the socket. Leave daemon startup and harness settings to the user.
On `worker_refused`, stop using `cusr`.

## Pause or stop work

- `task pause` lets the current attempt finish and holds the next step. `--now` also stops
  the running attempt. `task resume` continues with the same revision, worktree, and PR.
- `queue pause` holds new starts. Ask the user before `queue resume`.
- Before `task cancel`, show affected dependents from `task explain` and get the user's approval
  for the cascade. While `cancel_reconcile` runs, wait for the outcome. If it needs the user,
  use `--force` only on explicit request. Check the resulting state because a merge may have landed.
- Use `task fail` only when the user asks. It ends a waiting task and may create a draft PR for
  unpublished work. To start over on a separate task, use a fresh `task add` with the user's approval.

## Existing PRs and merge

- To continue an open PR, get approval to use `task add --pr OWNER/REPO#N` and set `--base` to
  the PR's base. The existing title and body stay in place. If the requested base is the head of
  an unmerged PR, preflight can wait with `stacked_base`. Use the target branch or wait for the
  prerequisite PR to merge. Intentional stacking via `stacked-base` is owner-only.
- For `adopt_approval`, present the PR and full head SHA. The owner reviews that head and runs
  the admin adoption action from `task explain` with the current task version. The daemon refuses
  a moved or ineligible PR head. The assistant keeps its own actor and hands the action off.
- The owner can use **Merge PR** in the TUI Actions dialog when the task is waiting to merge and
  the action is offered. The owner confirms the PR, target, head, method, and commit message. The
  daemon checks readiness, CI, and the head again. GitHub's merge UI is also available to the user.
- With yolo enabled, the daemon can merge eligible PRs automatically. The CLI has no merge
  command. Report the resulting state from `task show` after the daemon observes the actual merge.
