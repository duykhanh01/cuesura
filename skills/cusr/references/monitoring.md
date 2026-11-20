# Monitor work and reply

Run daemon commands with the environment and `--json` from [SKILL.md](../SKILL.md).

## Read status and logs

- Use `task explain` for the current wait, `allowed_actions`, failed gate or CI evidence, and overlapping
  scope. If scope is unknown, report it as unknown. Long silence with no runner start can mean no runner
  took the attempt. Use `--full` when the default view omits needed details.
- On completion, use `task show` and report `terminal.kind` and `terminal.reason`. A failed task may still
  have a draft PR. For DONE with `unverified`, report that the merged head lacks verified checks.
  Wait for verified evidence before building on it.
- Use `task gates` to find rounds and `task gate-log "$TASK_ID" "$GATE"` for gate output.
  `task history --tail` shows recent events. History and log cursors are separate.
- Use `task logs "$TASK_ID" --tail` for recent output, and `--attempt` for one attempt. Logs can include
  worker and deputy output. Use `model.id` if recorded and `model.binding` for the configured binding
  when present. A missing model ID stays unknown. Report missing-log gaps.

```sh
cusr task logs "$TASK_ID" --follow --tail --json
cusr task logs "$TASK_ID" --follow --after "$LOG_CURSOR" --json
```

With `--follow`, parse JSON Lines. The last line has `type: end` and a cursor. An error before
the stream is a JSON envelope. Handle `end` as follows.

| End reason | Action |
| --- | --- |
| `task_finished` | Read `task show` for the result. Exit 0 alone does not identify it. |
| `needs_user` | Read `inbox` and `task explain`. Relay the wait and resume with the cursor once it moves. |
| `session_limit` | Resume after the cursor. The stream session reached its one-hour limit. |
| `daemon_unreachable` | Run `cusr status`. |

## Wait for notifications

Use the Stop hook or `assistant wait` to wait without spending model turns on repeated status checks.
Use `task logs --follow` when the user wants live output from one task.

**With hooks from `cusr init`.** Take the lease with `assistant register --take` only when the user
asks. Relay the returned `items` and check `warnings` for a missing hook. The installed hook parks
after each turn and surfaces later events in messages starting with `cusr:`.

- For a wait, read `inbox` and `task explain`, then relay the finding. For `done`, `failed`, or
  `cancelled`, read `task show`. A harness launch failure may include a suggested fix.
- If another session takes the lease, general task updates go there. This session can still receive
  harness launch failures for tasks it added. Take the lease back only on request. Use
  `assistant unregister` when the user wants to stop notifications.
- For a daemon outage notification, run `cusr status` and tell the user. Check `task show` before
  waiting on a task started before this session registered because its completion may already have occurred.

**Without hooks.** On a harness that wakes the session when a background command exits, run
`cusr assistant wait --json` in the background. Relay returned items and pass the returned
`--lease "$LEASE"` on the next wait to acknowledge them. With `--timeout`, a reply with
`timed_out: true` has nothing to relay. An `attention_held` error after losing your own lease ID
is retried after `details.retry_after_ms` without `--lease`. For another session's lease, use
`--take` only on request. On `attention_superseded`, stop waiting for general updates.

## Answer or message

Use `inbox` to see blocking questions and waits. Read their `next` and `task_version`. When
`deputy: true`, the deputy is handling the item. If it hands off, relay the cause and decision.
Answer with the user's direction or established facts. Present any unresolved decision to the user.

```sh
printf '%s\n' "$ANSWER" | cusr answer "$QUESTION_ID" --file - \
  --expected-version "$VERSION" --request-id "$ID" --json
printf '%s\n' "$MESSAGE" | cusr task message "$TASK_ID" --file - \
  --expected-version "$VERSION" --request-id "$ID" --json
```

Send a message only when the user wants to guide existing work. State the new finding or decision
and the affected behavior. Keep the approved scope and acceptance. Messaging can stop a running
coder or fixer turn and count it against the budget. Use `--behavior queue` when it should wait.

For a project overview, `cusr report --project "$PROJECT" --since 24h --json` includes goals,
deputy decisions, and waivers. Report waivers as waived and relay `needs_you` items to the user.
