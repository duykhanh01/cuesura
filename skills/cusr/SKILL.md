---
name: cusr
description: >-
  Use the cusr CLI as an external Cuesura assistant to submit tasks or goals,
  choose run settings, report progress, answer questions, and handle task waits.
  Cuesura workers and deputies follow their role prompts.
---

# cusr

## Connect and act as the assistant

Cuesura workers must never call `cusr`. A deputy turn (`CUSR_DEPUTY_TURN` set) follows its role prompt.

Use the operator's absolute `DATA_DIR`. Ask if it is missing. Write this prefix in every daemon command,
including when copying a command from CLI output. In a pipeline, put it after the pipe.

```sh
CUSR_DATA_DIR="${DATA_DIR:?}" CUSR_ACTOR=assistant cusr project list --json
```

The examples below omit the prefix. Keep `CUSR_ACTOR=assistant` even if a command is refused. Use `--json`
and check the envelope's `ok` and `error`. Use `cusr help <command>` for flags, schemas, and examples.

- Get project IDs, profiles, and caller permissions from `project list`. Get the base branch from the
  operator or known project context. Use `doctor --project "$PROJECT"` for readiness problems.
  Compare `status` with `cusr --version --json` if the CLI and daemon may be on different builds.
- Before each versioned mutation, read the current task or goal with `show` and use its `version`.
  Give each mutation a UUID with `--request-id`. If the outcome is unknown, keep the same ID and input.
  Follow [request recovery](references/recovery.md#recover-a-request) before trying again.
- Read `task explain` before acting on a waiting task. Follow `allowed_actions` and the action's note.
  Hand `admin` actions to the user. A listed action or a wake notification grants no approval.

## Submit a task

1. Read `cusr dispatch --project "$PROJECT" --json`. Follow the user's settings first, then the best-fit
   `when` rule, then `default`. Pick the first `use[]` binding unless the user or a stated reason calls
   for another. If no rule fits and the default is null, ask.
2. Use the [brief template](assets/task-brief.md). Aim for about ten lines across description and acceptance.
   Link accessible context and give observable criteria. Omit copied issue text, repo rules, standard checks,
   daemon-managed steps, and implementation instructions unless the task specifically requires them.
3. Before adding, show one summary with the title, acceptance, out of scope, proposed profile, mode,
   worker and reviewer, and the matched dispatch rule. Wait for the user's approval or edits. Skip this
   summary only when the user explicitly asks, for that request only.
4. Add, inspect options, propose the approved settings, then read the new version and digest and confirm.
   A changed proposal needs the user's approval. If the user asked to review before confirming, wait.
   Otherwise confirm the approved settings yourself when `project list` reports
   `data.caller.trusted_confirmer: true`. If it is false, the user confirms the run config.

```sh
cusr task add --project "$PROJECT" --title "$TITLE" --base "$BASE" \
  --description "$DESCRIPTION" --acceptance "$ACCEPTANCE" --request-id "$ADD_ID" --json
cusr task options "$TASK_ID" --json
cusr task show "$TASK_ID" --json
cusr task propose "$TASK_ID" --profile "$PROFILE" --mode direct-pr --worker "$WORKER" \
  --reason "$REASON" --expected-version "$VERSION" --request-id "$PROPOSE_ID" --json
cusr task show "$TASK_ID" --json
cusr task confirm "$TASK_ID" --run-config "$RUN_DIGEST" \
  --expected-version "$VERSION" --request-id "$CONFIRM_ID" --json
```

- Use one acceptance criterion per line. With `--file`, use the JSON fields from `cusr help task add`
  and a stable `source_key` for a known issue or request. On `conflict` with `task_exists`, use the
  existing ID in `error.details.detail.task_id`.
- Bindings are `harness/model/effort`. Use `--reviewer` with `full-review` only, and name the dispatch
  rule in `--reason`. Omitted fallback flags use the available ladder rungs. An explicit empty
  `--fallback ''` or `--reviewer-fallback ''` disables that ladder. The daemon validates the proposal
  and rechecks it at start.
- If both the task and `cusr.yaml` omit a profile, `task options` can fail. Select a configured profile
  from `dispatch` or `project list`, or use the user's choice. Submit the approved full
  `task propose --profile …` even though options failed. Use the returned diagnostics for other config
  errors. `task options` reads the project clone's local `origin/<base>` without fetching.
- Use `--scope` when the paths or globs the task expects to change are known. Report `slot_block`
  when overlapping scope holds the task, and report any `config_warning` after add.
  Get approval before adopting an existing PR and use its target branch as the base.
  See [PR adoption and merge](references/recovery.md#existing-prs-and-merge).
- Read `task_id` from the add result. Before confirming, use the new `version` and `run_config.digest`
  from `task show`. Confirm with `--run-config` because intake alone can leave the task waiting.
  If confirmation partly commits, follow [request recovery](references/recovery.md#recover-a-request).

## Inspect work and handle waits

| User asks for | Start with |
| --- | --- |
| Current status, blocker, or next action | `task explain "$TASK_ID"` |
| Active tasks and who needs help | `task board` or `inbox` |
| What was requested | `task content "$TASK_ID"` |
| Completed steps and visits | `task progress "$TASK_ID"` |
| Result, PR, version, or run settings | `task show "$TASK_ID"` |

Read [monitoring and replies](references/monitoring.md) for hooks, logs, questions, or messages.
Use [recovery](references/recovery.md) for rejected mutations, rechecks, approvals, pauses, or cancels.
Use [goals](references/goals.md) when the user wants a deputy to plan and coordinate a goal.
