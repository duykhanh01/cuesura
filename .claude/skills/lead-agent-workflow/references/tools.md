# Tools

The skill speaks in seven capabilities. Each tool provides them differently, and some not at all.
Read the card for your tool before the first dispatch.

| Capability | What you need from it | If the tool lacks it |
| --- | --- | --- |
| **Spawn** | start a worker with a model, an effort level, a working directory | run the vendor's CLI in a worktree |
| **Resume** | send a follow-up to the same worker with its context intact | start a new worker that reads the report file and the ledger pointers |
| **Finish notice** | be woken when a worker ends its turn | a timed check-in plus a status read |
| **Timed wake** | wake yourself after a delay | a background command that sleeps and exits |
| **Status** | list workers and see their state and last activity | read the PR and `git log` on the branch |
| **PR watch** | be woken when checks finish, comments arrive, or a conflict appears | `scripts/pr-ci.sh <pr> --wait` in the background |
| **Ask the user** | a question the user sees as waiting on them | start your final message with the question |

## Whose rule wins

A tool may ship its own orchestration instructions. They decide the **mechanics**: which call
spawns, how to wait, what never to poll. This skill decides the **policy**: what to dispatch, the
gates, how findings are settled, and whether a worker is resumed or replaced.

Where a card below says "This skill replaces", the user chose this skill's policy over that line
of the tool's instructions by invoking the skill. Everything else in the tool's instructions
stands.

## Paseo

| Capability | How |
| --- | --- |
| Spawn | `create_agent` with `title`, `provider` as `provider/model`, `initialPrompt`, `workspaceId`, and `settings` (`modeId` for permissions, `thinkingOptionId` for effort). `list_profiles`, `list_providers` and `list_models` give the valid values. CLI: `paseo run`. |
| Workspace | `create_workspace` with `isolation: worktree` and `mode: branch-off`, `checkout-branch` or `checkout-pr`. |
| Resume | `send_agent_prompt` with the `agentId`: same provider session, context kept. `update_agent` changes the model, mode or effort on the same agent. CLI: `paseo send`. |
| Finish notice | `notifyOnFinish`, on by default when an agent creates or prompts another. It reports finished, errored, needs permission, closed. The message carries the last reply cut at 4000 characters, so ask for the report file. |
| Timed wake | `create_heartbeat` with a five-field cron and a prompt; it lands in your own conversation. `delete_heartbeat` removes it; to change one, delete and recreate. Without a timezone the cron is UTC. |
| Status | `list_agents`, `get_agent_status` (active turn, `backgroundWork.count`, `updatedAt`, `lastError`), `get_agent_activity`. |
| PR watch | None. Use `gh` and `scripts/pr-ci.sh`. |
| Ask the user | The question tool of the harness you run in. |

Where it bites:

- A lead that calls Paseo from outside (not as a Paseo agent) gets no finish notice. Wait with
  `paseo wait <agent-id>` in the background, or a timed check-in.
- Notices are at-least-once: one can repeat after a daemon restart, and one queued at an abrupt
  crash can be lost. A lead that is archived receives none. Reconcile with `list_agents` on every
  wake and keep a heartbeat as the fallback.
- A heartbeat that fires while you are mid-turn is recorded as a failed run and is not queued. Set
  the interval longer than your turns.
- An agent can sit at `idle` looking healthy after its background work died. Compare
  `backgroundWork.count` and `updatedAt` before you trust the status.
- Archiving a workspace closes its agents. If another session archived a live one: back up the
  session file, `paseo delete <agent>`, then `paseo import <sessionId> --provider claude --cwd
  <worktree>` and reset its name, mode and effort with `update_agent`. A Codex reviewer cannot be
  imported this way; start a new one with a delta brief.
- Not verified: whether sending a prompt to an archived agent revives it.

## T3 Code

| Capability | How |
| --- | --- |
| Spawn | `delegate_task` with `task`, plus `role`, `isolation: "worktree"`, `mode: "async"` and `target` (provider, model, options such as effort). Call `orchestrator_capabilities` once first for the valid targets. The child receives only `task`, with none of your history. |
| Resume | `t3_thread_send` to the child's `childThreadId`, leaving `freshContext` unset. A send to a finished child starts a new tracked task on the same provider session and returns its `taskId`. |
| Finish notice | Automatic. The result arrives as a message in your thread. End your turn after a dispatch. |
| Timed wake | None for this purpose. T3 forbids `sleep`, polling `task_status`, Monitor and ScheduleWakeup while a delegate runs. |
| Status | `task_status`, after the completion woke you. `task_cancel` stops a delegate. |
| PR watch | `watch_pull_request`, then end your turn. It wakes you on failed checks, passed checks, checks awaiting approval, new remarks, a conflict, no checks after 15 minutes, and a closed PR. A merge ends the watch silently. `unwatch_pull_request` before you hand off or ask the user. Only the thread that owns the PR can watch; children cannot. |
| Ask the user | The provider's own question tool. |

This skill replaces two lines of T3's orchestration instructions:

- T3 says every re-check is a new `delegate_task`, never a `t3_thread_send`. Under this skill, a
  fix or a re-check goes to the same child with `t3_thread_send`, so it keeps its context. Record
  each child's `childThreadId` in the ledger's Owner column. Send only after the child's completion
  has woken you; a send to a running child steers its current turn.
- T3 says to fix small review findings yourself. Under this skill the owning coder fixes them.

Where it bites:

- A follow-up runs on the model of the child's previous run. To move a task to a stronger model,
  start a new `delegate_task` whose brief points at the report file.
- Use `watch_pull_request` for waiting on CI. Run `scripts/pr-ci.sh` without `--wait` when you want
  the verdict in one line.
- Not verified in a live session: that a resumed child recalls its earlier work. On first use,
  test it once with a small task.

## Claude Code

| Capability | How |
| --- | --- |
| Spawn | The `Agent` tool with an explicit `model`; it runs in the background. `isolation: "worktree"` gives it its own checkout. |
| Resume | `SendMessage` to the agent id; the context is kept. |
| Finish notice | Automatic when a background agent ends. |
| Timed wake | `ScheduleWakeup` or `CronCreate`. |
| Status | The finish notice and the agent's final report. |
| PR watch | `scripts/pr-ci.sh <pr> --wait` as a background shell command; its exit wakes you. Where the app offers its own PR monitor, bind the PR to it and let it wake you. |
| Ask the user | `AskUserQuestion`. |

Where it bites:

- Native subagents run Claude models only, so there is one provider. For a reviewer from another
  family, drive that vendor's CLI or work through a tool that offers several providers; otherwise
  the single-provider rule in SKILL.md applies.
- An agent started without an explicit model inherits yours, which is usually the most expensive.

## A tool with no card

Probe the seven capabilities before the first dispatch: read the tool's own skill or help, then
try each call once on a throwaway task. Work from the fallback column where one is missing. After
the session, add a card here with what you found, marking anything you did not verify.

## Git host

The skill assumes GitHub through `gh`, and `scripts/pr-ci.sh` for verdicts. On another host, map
five operations to its CLI: open a PR, read the head SHA and changed files, read check results,
mark ready, merge. Keep the verdict names from `supervision.md`.
