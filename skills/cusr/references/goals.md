# Goals

A goal preserves one user request. The deputy proposes the plan and the user approves its hash.
Several units run as tasks and integrate on a goal branch into one PR. Use `task add` for a small,
clear task that does not need a deputy plan.

Every goal write requires this session to hold the assistant lease. See
[waiting and notifications](monitoring.md#wait-for-notifications) and take the lease only when the
user authorizes it. Reads need no lease.

```sh
cusr goal add --project "$PROJECT" --base "$BASE" --file "$REQUEST_FILE" --request-id "$ID" --json
cusr goal list --project "$PROJECT" --json
cusr goal show "$GOAL_ID" --json
cusr goal confirm "$GOAL_ID" --plan-hash "$PLAN_HASH" \
  --expected-version "$VERSION" --request-id "$ID" --json
printf '%s\n' "$NOTE" | cusr goal note "$GOAL_ID" --file - \
  --expected-version "$VERSION" --request-id "$ID" --json
```

- Ask before `goal add` and pass the request verbatim. If there is no deputy role, tell the user
  the goal is waiting for a plan via `goal propose`.
- Show the whole plan from `goal show`, including summary, scope, non-goals, each unit's acceptance,
  scope and dependencies, and parallel groups. Confirm only the hash the user approved. If the
  hash changes, show the new plan for approval.
- For `amendment_pending`, show `pending_amendment.plan` and `pending_amendment.parallel_groups`.
  After the user approves that amendment, pass `pending_amendment.plan_hash` to `--plan-hash` with
  the current goal `version`.
- `goal note` records the user's directive for the deputy. Run `goal revise` or `goal cancel` only
  on request. Cancel also stops every unfinished unit task.
- A multi-unit plan needs `ci.required_checks` in `cusr.yaml`. Report `no_required_checks` to
  the user if confirmation is refused for that reason.
- Use `goal show` for the units, incidents, and decisions on one goal. Use `goal list --all`
  to include ended goals and `cusr report` for a project overview.
