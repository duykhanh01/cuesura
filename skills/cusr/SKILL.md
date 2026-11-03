---
name: cusr
description: >-
  Use the cusr CLI as an external assistant caller to submit and inspect Cuesura
  tasks, propose run settings, answer questions, recheck, and cancel. Worker
  agents launched by Cuesura must not use this skill.
---

# cusr

## Help

```sh
cusr --help
cusr task --help
cusr --version --json
cusr dispatch --help
cusr task add --help
cusr task propose --help
cusr task confirm --help
cusr task recheck --help
cusr task logs --help
```

## Connection and argument values

```sh
# External assistant callers only. Workers must not invoke the control CLI,
# including on their own task, even if this skill is visible to them.
# DATA_DIR and TOKEN_FILE: nonempty absolute paths supplied by the operator.
# TOKEN_FILE must be the caller's separate project-scoped read/operate token.
# Never read/use the owner token, unset TOKEN_FILE, or fall back to default auth.
# Refuse to proceed if the operator has not provided the intended connection.
# Repeat both guarded environment assignments on EVERY daemon invocation;
# exports/functions from a previous shell call may not survive the next call.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr status --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr doctor --project "$PROJECT" --json

# PROJECT and BASE: operator-supplied configured project ID and target branch.
# PROFILE, WORKER, REVIEWER, FALLBACKS: operator-supplied allowed run settings,
# matching the effective project configuration. Do not guess names or bindings.
# Read run-setting guidance with `cusr dispatch` before proposing a run. An empty
# rules list with a default is valid: use the default. If default is null, ask the
# operator for the values and guidance; do not guess.
# TASK_ID, VERSION, RUN_DIGEST: task show -> task_id, version, run_config.digest.
# Request IDs are UUIDs: retain one per mutation; exact delivery retries reuse it
# with unchanged input/version. After a conflict or changed decision, reread state
# before allocating a new ID. Do not create duplicate tasks after a timeout.
```

## Add tasks

```sh
# Submit -> propose run settings -> confirm the run digest with your own token.
# A complete run_config in the add input already supplies the proposal.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task add --project "$PROJECT" --title "$TITLE" --base "$BASE" \
  --description "$DESCRIPTION" --acceptance "$ACCEPTANCE" \
  --request-id "$ADD_REQUEST_ID" --json

# Optional task flags: --depends-on ID,ID --priority N
# --acceptance takes one criterion per line.
# A run proposal needs --profile, --mode and --worker TOGETHER.
# full-review also needs --reviewer; direct-pr must omit --reviewer.
# If BOTH --mode and --worker are absent, --profile/--reviewer/--fallback/--reason
# are ignored. If either is present without the required trio, the CLI errors.

# With --file, put ALL task fields and any run_config in the JSON object.
# Do not mix --file with task/run flags: --title, --base, --description,
# --acceptance, --priority and --depends-on do not override the file.
# A complete run-flag proposal replaces the file's run_config, not individual keys.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task add --file "$TASK_FILE" --request-id "$ADD_REQUEST_ID" --json
```

`--file` takes a strict JSON object. Replace the example values before submission:

```json
{
  "project": "configured-project-id",
  "title": "Requested change",
  "base_branch": "target-branch",
  "description": "Desired behavior and context",
  "acceptance": ["Observable acceptance criterion"],
  "depends_on": [],
  "priority": 0
}
```

```sh
# Required: project, title, base_branch. Provide nonempty acceptance for execution.
# Other accepted task keys: type, requirements, constraints, out_of_scope, size,
# labels, profile, source_key. Unknown/server-assigned keys are rejected.
# depends_on: task UUID array; priority: integer -1000..1000, higher runs first.
# The optional run_config object requires profile, mode, reason, worker, reviewer,
# and fallbacks. Other task text fields are strings; requirements/constraints/
# out_of_scope/labels are string arrays. size is XS/S/M/L/XL or null.
# worker/reviewer/fallback entries use {harness, model, effort}; direct-pr uses
# reviewer:null. Use [] for no fallbacks; do not invent allowed choices.
# --project can override the file's project, but these examples keep it in JSON.
```

## Inspect tasks and output

```sh
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task list --project "$PROJECT" --limit 100 --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task list --project "$PROJECT" --cursor "$NEXT_CURSOR" --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task show "$TASK_ID" --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task explain "$TASK_ID" --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task history "$TASK_ID" --after "$EVENT_CURSOR" --limit 100 --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task logs "$TASK_ID" --after "$LOG_CURSOR" --limit 100 --json

# Finite --json output: {schema_version, ok, data, error}; check ok and task status.
# List: next_cursor -> --cursor; history/logs: next_cursor -> --after.
# Event and log cursors are different. Surface missing-log gap records.
# --follow emits JSONL records, not one result envelope; initial errors can still
# be envelopes. Both end:session_limit and end:task_finished exit 0.
# session_limit ends only this one-hour log session. Save its cursor and resume;
# task_finished also does not distinguish DONE from FAILED/CANCELLED: read show.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task logs "$TASK_ID" --follow --after "$LOG_CURSOR" --json
```

## Propose run settings

```sh
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr dispatch --project "$PROJECT" --json
# data.rules[]: {when, why, profile, mode, use[]}; data.default has the same choice
# fields; data.modes holds when_to_use; data.source says whose rules these are:
# project, global (the shared fallback) or none. Precedence: an explicit user instruction,
# then the best-fit `when`, then default. You match `when`; the daemon never does.
# use[] is ordered: propose the first unless the user or a stated reason says
# otherwise. Copy worker/reviewer verbatim and name the matched rule in --reason.
# A proposal does not start the task: confirm its digest next.
# Bindings: HARNESS/MODEL/EFFORT, from the operator's configured allowlist.
# Set VERSION from a fresh task show before each NEW mutation.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task propose "$TASK_ID" --profile "$PROFILE" --mode direct-pr \
  --worker "$WORKER" --reason "$REASON" \
  --expected-version "$VERSION" --request-id "$PROPOSE_REQUEST_ID" --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task propose "$TASK_ID" --profile "$PROFILE" --mode full-review \
  --worker "$WORKER" --reviewer "$REVIEWER" --reason "$REASON" \
  --expected-version "$VERSION" --request-id "$PROPOSE_REQUEST_ID" --json
# Optional: --fallback HARNESS/MODEL/EFFORT,...
# Show the resulting selection, reason, fallbacks and digest to the user.
```

## Intake confirmation

```sh
# Intake/config check ONLY. This alone does not approve run settings.
# READY can still be run_config_unconfirmed: add --run-config to confirm the digest.
# Follow the user's instruction if they asked to review the run settings first.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task confirm "$TASK_ID" --expected-version "$VERSION" \
  --request-id "$INTAKE_REQUEST_ID" --json
# Read task show for the CURRENT version and digest, then confirm both in one call.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task confirm "$TASK_ID" --run-config "$RUN_DIGEST" \
  --expected-version "$VERSION" --request-id "$CONFIRM_REQUEST_ID" --json
# A confirm --run-config error can occur after
# intake changed the version. Re-read show/history; do not reuse the stale version
# for a new command, and do not switch to the owner token to make it succeed.
```

## Questions

```sh
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr inbox --task "$TASK_ID" --json
# QUESTION_ID and current task_version come from the inbox item.
# Supply the user's answer or known facts; unresolved decisions go to the user.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr answer "$QUESTION_ID" --file "$ANSWER_FILE" \
  --expected-version "$VERSION" --request-id "$ANSWER_REQUEST_ID" --json
```

## Report

```sh
# What happened since a moment, per project: finished tasks (PR, reason, usage),
# tasks waiting for the user with their open questions, running tasks and decider answers.
# Built from the event log, no model. --since takes 30m, 8h, 2d or an ISO time (default 24h).
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr report --project "$PROJECT" --since 24h --json
# Present it to the user as is; do not act on needs_you items without the user.
```

## Recheck and cancel

```sh
# Always read task explain before recheck; it is state-dependent, not a status read.
# For WAITING/worktree_changed, inspect the actual diff and obtain the user's
# approval of that specific diff BEFORE recheck: it adopts the observed tree and
# enables the step to rerun. If the diff is unavailable, hand off to the user.
# allowed_actions describes available commands, not permission to accept changes.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task explain "$TASK_ID" --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task recheck "$TASK_ID" --expected-version "$VERSION" \
  --request-id "$RECHECK_REQUEST_ID" --json
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${TOKEN_FILE:?}" \
  cusr task cancel "$TASK_ID" --reason "$REASON" \
  --expected-version "$VERSION" --request-id "$CANCEL_REQUEST_ID" --json
# Recheck does not extend a deadline frozen in an older task. Cancel does not undo a merge;
# inspect the resulting state rather than treating command exit 0 as completion.
```

## User-only commands to hand off, never execute as an assistant

```sh
# ONLY THE USER executes these in their own terminal/trusted channel, even if an
# owner token is readable by the agent. Do not read, acquire or use that token.
# USER_TOKEN_FILE below belongs to the user's connection, never the assistant's.
# Present the escalation reason/step/rung and this command.
# The user reads show again for the CURRENT version before approving.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${USER_TOKEN_FILE:?}" \
  cusr task show "$TASK_ID" --json
# Escalation approval requires admin privileges; it is not run confirmation.
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_TOKEN_FILE="${USER_TOKEN_FILE:?}" \
  cusr task approve "$TASK_ID" --kind escalation --step "$STEP" --rung "$RUNG" \
  --expected-version "$VERSION" --request-id "$APPROVE_REQUEST_ID" --json
```

## Unsupported commands and alternatives

```sh
# task retry -> task add for independent work the user actually wants.
# task amend-policy -> cancel, then task add with updated input/configuration.
# task approve --kind merge and the yolo command -> with yolo on, the daemon merges by
# itself; never call a merge yourself. Otherwise the user merges on GitHub, then observation
# or an allowed task recheck records it. This CLI has no merge command.
```
