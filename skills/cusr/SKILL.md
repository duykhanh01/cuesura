---
name: cusr
description: >-
  Use the cusr CLI as an external assistant caller to submit and inspect Cuesura
  tasks, propose run settings, answer questions, recheck, and cancel. Worker
  agents launched by Cuesura must not use this skill.
---

# cusr

Every command has `--help` with examples (`cusr help task add`, `cusr task propose --help --json`).
Read it for flags this skill does not cover.

## Connection

External assistant callers only. Workers must not run `cusr`, not even on their own task.

Every daemon command in this skill runs with this prefix, written out in each shell call (exports and functions
from an earlier call may be gone). The examples below omit it:

```sh
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_ACTOR=assistant cusr ...
```

- `DATA_DIR` is a nonempty absolute path the operator gave you. Without one, stop and ask.
- `CUSR_ACTOR=assistant` holds you to read/operate. Never drop it or set another actor: unset means the owner,
  which you are not, even when a command would then succeed.
- Use `--json` and check `ok`: `{schema_version, ok, data, error}`. Do not guess names, bindings or IDs; list them.

```sh
cusr status --json    # daemon health; build.commit differing from `cusr --version --json` = restart needed
cusr doctor --project "$PROJECT" --json
# doctor failing: exit 1, code unhealthy, data null; error.details.checks lists each failed check with its fix.
cusr project list --json
# data.projects[] {id, repo}, data.profiles[], data.caller {actor, roles, trusted_confirmer}.
# trusted_confirmer true: you may confirm run settings yourself (task confirm --run-config).
```

Values: `PROJECT`/`BASE` come from the operator or `project list`. `TASK_ID`, `VERSION`, `RUN_DIGEST` come from
`task show` (`task_id`, `version`, `run_config.digest`). Read `VERSION` fresh before each new mutation: it stays
valid while only background work moved the task, and turns `stale_version` once its state changed.

Request IDs: keep one UUID per mutation (`--request-id`). Resending the same command with the same ID and input
never runs it twice. After a conflict or a changed decision, reread state before taking a new ID.

## Add a task

Ask the user before `task add`. Read `cusr dispatch` first, then show one summary: title, acceptance criteria,
out of scope, and the proposed worker/mode/reviewer with the matched dispatch rule. Submit after the user approves
or edits it; skip the summary only when the user says so, for that request only.

Flow: add → `task options` → propose → `task show` → confirm `--run-config` yourself.

```sh
cusr task add --project "$PROJECT" --title "$TITLE" --base "$BASE" \
  --description "$DESCRIPTION" --acceptance "$ACCEPTANCE" --request-id "$ID" --json
cusr task add --file "$TASK_FILE" --request-id "$ID" --json
```

- `--acceptance` takes one criterion per line and is required (none: `invalid_arguments`).
- `--file` is a strict JSON object: `project`, `title`, `base_branch`, `acceptance` (nonempty list), and optionally
  `type`, `description`, `requirements`/`constraints`/`out_of_scope`/`labels` (string lists), `depends_on`
  (task IDs), `priority` (integer −1000..1000, higher first), `size` (XS..XL or null), `profile`, `source_key`,
  `pr_ref`, `scope`, `run_config`. `task add --help` lists them too. `--title`, `--base`, `--description`,
  `--acceptance`, `--priority`, `--depends-on` beside `--file` are refused; put them in the file.
- `source_key`: set a key stable for the work, e.g. `issue:owner/repo#12`. Adding the same work again is then
  refused (`conflict`, reason `task_exists`, `details.detail.task_id`) instead of making a duplicate.
  Without it every add is a new task, so never re-add after a timeout: see Timeouts.
- `--depends-on ID,ID`, `--priority N`.
- `--scope PATH,GLOB` (JSON `scope`): repo-relative paths/globs the task expects to change (`*`, `**`, `?`, `[...]`
  only). A task sharing them does not run alongside. add/propose/confirm results carry `slot_block` when it shares
  files with a task holding a slot: tell the user it waits for that task.
- `--pr OWNER/REPO#N` (JSON `pr_ref`) continues that open PR: `--base` is its base branch and the user approves
  adopting it (User-only commands). The PR keeps its title and body; workers only add commits.
- `--base` must not be an unmerged PR's branch: preflight holds the task as `config_invalid`/`stacked_base` and it
  turns READY by itself once that PR merges. Ask the user; use `--pr`, or the PR's base. Only the user may stack on
  purpose (label `stacked-base` on a task they add); on yours the label is ignored.
- Run flags on add (`--profile --mode --worker ...`) make the proposal in the same call, checked against
  `task options` before the task exists.

## Run settings

```sh
cusr dispatch --project "$PROJECT" --json
cusr task options "$TASK_ID" --json
cusr task propose "$TASK_ID" --profile "$PROFILE" --mode direct-pr --worker "$WORKER" \
  --reason "$REASON" --expected-version "$VERSION" --request-id "$ID" --json
cusr task propose "$TASK_ID" --profile "$PROFILE" --mode full-review --worker "$WORKER" \
  --reviewer "$REVIEWER" --reason "$REASON" --expected-version "$VERSION" --request-id "$ID" --json
cusr task confirm "$TASK_ID" --run-config "$RUN_DIGEST" --expected-version "$VERSION" \
  --request-id "$ID" --json
```

- `dispatch`: `rules[] {when, why, profile, mode, use[]}`, `default` (same fields), `modes` (when_to_use) and
  `source`: `repo` (cusr.dispatch.yaml), `global` (dispatch.yaml) or `none`. Precedence: an explicit user
  instruction, then the best-fit `when` (you match it; the daemon never does), then `default`. `use[]` is ordered:
  take the first unless the user or a stated reason says otherwise; name the matched rule in `--reason`. Empty rules
  with a default: use the default. `default: null`: ask the operator; do not guess.
- `task options`: `profile {id, source}`, `modes[]` with `when_to_use`, `reviewers[]`,
  `reviewer_fallbacks[] {choice, fallbacks[]}` and `workers[] {choice, fallbacks[]}`. A choice is `{harness, model, effort}`; the flags take it joined as
  `harness/model/effort`, e.g. `{"harness":"claude","model":"opus","effort":"high"}` → `--worker claude/opus/high`.
  It is a menu, not proof: the daemon checks again at start. `truncated: true`: cut at 64 combinations. Errors:
  `config_invalid`/`options_unavailable` (exit 1), `conflict` once started (6), `task_not_found` (4): do not guess.
- `--profile`, `--mode`, `--worker` go together; `full-review` also needs `--reviewer`, `direct-pr` must not have
  one. Without `--fallback` the fallbacks are the worker's ladder rungs from `task options`; `--fallback a/b/c,...`
  sets them, `--fallback ''` empties them (the first escalation then ends the task, `run_config_unconfirmed`).
  `--reviewer-fallback` does the same for the reviewer's ladder (`full-review` only). An off-menu value is
  `rejected` with `details.valid_values`.
- The proposal must match the summary the user approved; a change needs a new approval. A proposal does not start
  the task.
- `task confirm` without `--run-config` confirms intake only; the task can be READY yet `run_config_unconfirmed`.
  Confirm with the CURRENT version and digest; follow the user if they asked to review the settings first. A
  confirm error may come after intake changed the version: reread, never reuse the stale version, never drop
  `CUSR_ACTOR`.

## Read tasks

Defaults hold what a progress question needs; null and empty fields are left out (absent = none). `--full`
(show/explain/list/history) and `data.details` give the rest.

```sh
cusr task explain "$TASK_ID" --json      # where it is and what to do next
cusr task show "$TASK_ID" --json         # status, step, wait, pr_ref, terminal, version, run_config
cusr task content "$TASK_ID" --json      # what was asked; quote it back before approval
cusr task progress "$TASK_ID" --json     # steps: past, current, remaining, not_required, with visits
cusr task board --json                   # live tasks; attention lists the ones needing you
cusr task list --project "$PROJECT" --json
cusr task gates "$TASK_ID" --json        # gate rounds, pass/fail, whether each log is readable
cusr task gate-log "$TASK_ID" "$GATE" --json    # end of the latest round's log of that gate
cusr task history "$TASK_ID" --tail --json
cusr task logs "$TASK_ID" --tail --json
```

- explain: status, step, wait, blockers, `running` (binding, started_at, last_output_at, silent_ms),
  queue_position, pr, `failed` (failed gates, failing CI checks on the head, request_changes), allowed_actions,
  dependents, scope. A large `silent_ms` with no `started_at`: no runner took it; say it may be hung.
  `scope.overlaps`/`base_conflicts`: report them before they burn slots; `scope.unknown`: say so instead of "no
  overlap"; `scope.slot_block`: waits on tasks sharing files.
- A finished task has `terminal {kind, reason}`: report the reason. DONE with `unverified`: the merged head is not
  the checked one; never report "done, CI green" or build on it.
- board: `items` (this page) and `attention.items`, every task that needs the user, including ones with no question
  (paused, escalation, config, effect_unknown); a task on the page appears there as `{task_id, wait_code}`.
  `--scope terminal|all`, `--status`, `--project`, `--cursor`.
- list: newest first, 20 per page; `next_cursor` → `--cursor`; `--order oldest`; `--status`.
- gates → gate-log: `--round N` for an older round, `--full` for the whole log, `--offset BYTES` to read forward.
  An unknown gate is exit 4 `gate_not_found` with `details.gates`.
- history: 50 events per page, `--tail` newest, `next_cursor` → `--after`. logs: 20 records per page, trimmed
  (`--full` keeps them as recorded), `--limit` ≤ 200, `--attempt ID` for one attempt, `next_cursor` → `--after`.
  Event and log cursors differ. Report missing-log gap records.

```sh
cusr task logs "$TASK_ID" --follow --after "$LOG_CURSOR" --json
```

- `--follow` prints JSON Lines (an error before streaming is still one envelope). Each line has `schema_version`
  and `type`: `record`, `diagnostic` (log_gap), `state` (the task entered or left a wait: status, wait_code,
  needs_user) or `end`, the last line, with the cursor to resume from and a reason:
  - `task_finished` (exit 0): read show; it does not tell DONE from FAILED/CANCELLED.
  - `needs_user` (exit 0): wait_code says for what; read inbox/explain, relay it, follow again with `--after`
    once it moves.
  - `session_limit` (exit 0): only this one-hour session ended; resume.
  - `daemon_unreachable` (exit 3): the daemon stayed away 15 s; run `cusr status`.
- A cursor past the last record is `invalid_arguments` (exit 2).

## Timeouts

`daemon_timeout` (exit 3): the daemon runs but did not answer in time; the mutation may have happened.
`details.guidance` names the request. Look it up, or resend the SAME command with the SAME `--request-id`; never
with a new ID. confirm, cancel, recheck and approve `--kind adopt` wait up to 4 minutes (git and GitHub).

```sh
cusr request show "$REQUEST_ID" --json
```

- Exit 0 even when the operation was rejected: read `data.state`. `completed`: `data.outcome` is the original
  result (`task_id` for add). `in_progress`: look again later. `interrupted`: follow `data.next_step`, then resend
  the same command, ID and version. An `internal` error (exit 1) carries the request ID: retry it the same way.
- `request_not_found` (exit 4): not admitted yet, it may still arrive. Follow `details.next_step`; check
  `task list` before re-adding. Only the same actor sees a request.

## Errors of a mutation

- Refusals carry `details.guidance`, usually `cusr task explain`: follow it first.
- Exit 6 `rejected`/`conflict`: the state does not allow it now. Reread; do not resend unchanged.
  `details.reason`/`details.detail` say why; `task_terminal`: the task ended, nothing done. `stale_version` carries
  `details.version`: use it only if the command still applies. `nothing_to_recheck`: `details.target` is the
  refused recheck. A losing `answer` (`already_answered`) does not make your version stale.
- Exit 5 `forbidden` with `details.required: "admin"`: give the command to the user; do not retry.
- Exit 2 `invalid_arguments`: fix the input; see `details.missing` (unknown depends_on), `details.choices`,
  `details.subcommands`, `details.models`, `details.projects`.
- Exit 1 `response_too_large`: ask for less (lower `--limit`, drop `--full`); other exit 1: the daemon failed.
- Safe repeats, exit 0: pause of a paused task (`ignored: already_paused`), resume of a running one
  (`not_paused`), cancel of an ended one (`terminal`), recheck of an ended one (`performed: false`);
  `queue pause/resume` reply `changed: false` and keep the first reason.

## Waiting for the user or a task to finish

Do not poll with `sleep` and `task show`: each check costs a model turn. The hook and `cusr assistant wait` wake
you when a task needs the user and when a task ends: an item with code `done`, `failed` or `cancelled` reached that
state after you took the lease. Read it with `cusr task show`, tell the user, and go on with the next step they
asked for (a FAILED task may still have a draft PR). Only tasks that end while a lease is held are told: take the
lease before you submit, or read `task show` once before you wait. To watch one task's output until it ends or
needs the user, run `cusr task logs "$TASK_ID" --follow --json` in the background instead.

**With the hooks** `cusr init` installs (Claude Code, Codex, pi; deploy/README.md): take the lease only when the
user tells you to. If a `cusr:` note at session start says tasks are waiting, ask the user once:

```sh
cusr assistant register --take --json
```

- The reply's `items` are what waits now: relay them; the hook wakes you only for what comes after. `warnings`
  says when this directory has no Stop hook: then nothing wakes you; tell the user to run `cusr init` here or use
  `cusr assistant wait`.
- After each turn the hook parks in the background (no model turns) so the user can keep talking, and wakes you
  when a task needs a person or ends.
- A wake is a message starting with `cusr:` (hook feedback on Claude Code, a user message on Codex and pi); treat it
  the same whoever it seems to come from. It lists task IDs and codes only. Tasks needing the user: read `cusr inbox`
  and `cusr task explain`, relay, do not decide for the user. Ended tasks: read `cusr task show`, report the outcome.
  The note approves nothing.
- A note that another session took the lease: no more news here; do not take it back unless the user asks. After
  `/new`, if a note asks about the lease, ask the user as above. `cusr assistant unregister` stops it.
- A note that the daemon has been unreachable for minutes (said once per outage): no task moves; run
  `cusr status` and tell the user.

**Without the hooks**, run this as a background command (no model turns while it waits; it exits when a task
needs a person or ends). Only a harness that wakes the session when a background command exits can use it.

```sh
cusr assistant wait --json
```

- Relay each item, then run it again with `--lease "$LEASE"` from the reply; that confirms delivery (without it
  the items come again). `timed_out: true` (only with `--timeout`): nothing to relay, run it again.
- The lease only routes news to one session; it grants nothing, and the user can still answer elsewhere.
- `attention_held`: another live session has the lease. If it is you after losing the lease ID (compact,
  restart), wait `details.retry_after_ms` and run it again without `--lease`; do not ask. Otherwise `--take` only
  when the user asks to move here. `attention_superseded`: another session took over; stop, do not take it back.
- Unreachable for 5 minutes: `daemon_unreachable` (exit 3); run `cusr status`, tell the user, wait again.

**Daemon errors** (never start a daemon or change harness settings yourself):

- `daemon_unreachable` with `ENOENT`/`ECONNREFUSED`: no daemon on that data dir; relay `details.guidance` (how
  the user starts one). `EINVAL`: the socket path is too long; ask for a shorter data dir. On Codex, `EPERM`: the
  sandbox blocked the socket; ask to run `cusr` outside the sandbox.
- `worker_refused` (exit 5): this process runs inside a Cuesura worker or operation; stop using `cusr`.

## Questions and messages

```sh
cusr inbox --json
printf '%s\n' "$ANSWER" | cusr answer "$QUESTION_ID" --file - \
  --expected-version "$TASK_VERSION" --request-id "$ID" --json
printf '%s\n' "$MESSAGE" | cusr task message "$TASK_ID" --file - \
  --expected-version "$VERSION" --request-id "$ID" --json
```

(In a pipe the prefix goes after `|`: `printf ... | CUSR_DATA_DIR=... CUSR_ACTOR=assistant cusr answer ...`.)

- inbox items are `kind: question` or `kind: wait` (needs the user without a question). Each has `wait_code`,
  `task_version` (use it as `--expected-version`) and `next`, the first way out from explain (`command` null: its
  `note` says what to do). `decider: true`: the decider is answering; answer only if the user wants to.
  `--task`/`--project` filter (a wrong one is an error); `truncated`: pass `next_after` as `--after`.
  `queue_paused`: nothing not yet started runs until `cusr queue resume`; ask the user first.
- Answer with the user's answer or known facts; unresolved decisions go to the user.
- `task message` gives a task's agents guidance without a question or a cancel. A running coder/fixer turn stops and
  its session continues with the message; a reviewer, a paused task or `--behavior queue` gets it next turn. Never
  use it to widen the task or its acceptance (agents ignore that). The stopped turn counts against the budget;
  send messages the user asked for.

```sh
cusr report --project "$PROJECT" --since 24h --json
# Since a moment (30m, 8h, 2d, epoch ms, ISO time): finished tasks, tasks waiting for the user, running tasks,
# decider answers, queue_paused. Present it as is; do not act on needs_you items without the user.
```

## Recheck, continue, approve, pause, cancel

Always read `task explain` first. `allowed_actions[]` has `action`, `command`, `note` and `requires` (`operate`,
`admin`: hand it to the user, or null: no command, `note` says what is missing). It lists commands, not permission
to accept changes. A wait whose `resume_when` has `answer(<qid>)` ends only with that answer. Base repair takes
exactly "continue" or "retry fixer".

```sh
cusr task recheck "$TASK_ID" --expected-version "$VERSION" --request-id "$ID" --json
cusr task continue "$TASK_ID" --expected-version "$VERSION" --request-id "$ID" --json
cusr task amend-policy "$TASK_ID" --model "$MODEL" --effort "$EFFORT" --json
cusr task approve "$TASK_ID" --kind escalation --step "$STEP" --rung "$RUNG" \
  --expected-version "$VERSION" --request-id "$ID" --json
cusr task pause "$TASK_ID" --reason "$REASON" --expected-version "$VERSION" --request-id "$ID" --json
cusr task resume "$TASK_ID" --expected-version "$VERSION" --request-id "$ID" --json
cusr task cancel "$TASK_ID" --reason "$REASON" --expected-version "$VERSION" --request-id "$ID" --json
```

- recheck depends on the wait:
  - `worktree_changed`: inspect the actual diff and get the user's approval of that diff BEFORE recheck; it adopts
    the observed tree and reruns the step. No diff available: hand off to the user.
  - `manifest_changed`: recheck only when the user approved the harness re-proof; it switches to the manifest in
    force and reruns the step.
  - `harness_auth`: the user signs in again on the daemon host; recheck after they say so. Never loop it.
  - `loop_exhausted`: offered only when the latest attempts failed on infrastructure, rate limit or login; it
    gives those visits back. Ask the user to fix the cause first.
- continue (offered for ladder_exhausted, rung_denied, escalations_exhausted, quality loop_exhausted): same model,
  fresh tries. Read the latest review/gate failures first; when they repeat with no progress, report instead.
- amend-policy without `--confirm` only previews (rung, binding, approval need, `policy_hash`); confirming needs
  admin: hand it to the user.
- approve `--kind escalation` (wait `escalation`): you may approve it; it is a rung of the frozen ladder the user
  configured. Take step and rung from explain's command.
- pause instead of cancel when work must stop for a while: started work finishes, the next step waits as `paused`,
  the slot goes back. resume continues on the same revision, worktree and PR. `--now` also stops the running
  attempt. `cusr queue pause --reason ...`/`cusr queue resume` hold every task not started yet; allowed_actions
  then offer `resume_queue`.
- cancel: read explain's `dependents` first; ending CANCELLED or FAILED cancels all of them down the chain. Name
  them to the user and get their go. Once requested, explain offers `wait`, not cancel. Cancel does not undo a
  merge; check the resulting state. `cancel_reconcile` is not stuck (the daemon rereads the PR); only with
  `needs_user` tell the user, and add `--force` ONLY when the user asks.

## User-only commands: hand off, never run

The user runs these in their own shell, without `CUSR_ACTOR` (as the owner). Never run them yourself, with or
without it. The user reads `task show` again for the current version first.

```sh
CUSR_DATA_DIR="${DATA_DIR:?}" cusr task approve "$TASK_ID" --kind adopt --head-sha "$HEAD_SHA" \
  --expected-version "$VERSION" --request-id "$ID" --json
CUSR_DATA_DIR="${DATA_DIR:?}" cusr task amend-policy "$TASK_ID" --model "$MODEL" --effort "$EFFORT" \
  --reason "$REASON" --confirm "$POLICY_HASH" --expected-version "$VERSION" --request-id "$ID" --json
```

- adopt (wait `adopt_approval`, task added with `--pr`): present the PR and its full head SHA (explain shows it in
  `wait.detail.head_sha` once read). It refuses forks, closed PRs, another base, a moved head, a PR a live task holds.
- amend-policy confirm: a hash that no longer matches means state or config changed: preview again.

## Not supported

- `task retry` → `task add` for independent work the user wants. Another workflow on a started task → cancel, add.
- No merge command. With yolo on, the daemon merges by itself; otherwise the user merges on GitHub and observation
  or an allowed recheck records it. Never merge yourself.
