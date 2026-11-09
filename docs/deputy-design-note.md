# Deputy: design note

> **Not implemented.** Feature 007 was specified but no code was written before the project was archived. This
> note records where the design ended up after several rounds of review, because the reasoning may be useful on
> its own.

## Problem

Left running overnight, tasks stop and wait for a person wherever judgment is needed: retries exhausted at every
model rung, a reviewer and a fixer bouncing the same finding, a budget or deadline reached, a worker asking about
the spec. In the morning the owner unblocks each one by hand. The deputy is an agent that acts for the owner at
those points, through the same `cusr` commands, with a recorded reason for every command. The owner always wins
(commands are version-checked), and the deputy never merges.

The owner wanted three things at once:

1. Context and tokens that do not grow over time, and no repeated investigation.
2. Efficiency: as much parallelism as is safe, loops detected and broken, and a clear call on when to raise the
   model, raise a limit, or stop.
3. Easy communication: hand over one small task or a whole multi-step feature, approve a plan once, and talk to
   the system from any assistant session.

## Options considered

| Option | Why it was rejected or changed |
| --- | --- |
| One long-lived deputy session per task (the first spec) | Context grows with every incident; resuming after the prompt cache expires re-reads the whole transcript; no view across tasks; only that session can read its memory |
| One session per day | Tasks queue behind one session; context mixes tasks; the day boundary is arbitrary |
| The owner's assistant session doubles as deputy | Owner intent and agent decisions become indistinguishable, permissions blur, the session dies with the terminal, chat noise pollutes memory |
| One deputy per group of tasks, long-lived | Still grows over time; incidents within the group queue behind each other |
| One deputy plus a context-compression proxy | Solves only context size; adds a dependency and an unauthenticated proxy in the credential path |

## Final design

### Role, not session

The deputy is a durable role. Its memory lives in SQLite; each incident opens a short-lived session that starts
from a small, structured context (about 2-4k tokens) and reads logs or diffs only when needed. Within one turn
(for example after waiting out a rate limit) the session is resumed; a new turn starts a new session.

### Goal and ledger

- A **goal** is what the owner asked for: one or more tasks. A single small task is a goal with one task and runs
  exactly like before.
- The **ledger** is a view built from what is already stored (events, the command ledger, the goal aggregate and
  the deputy turn records), not a second source of truth. It holds the original request verbatim, the plan and
  its state, decisions with reasons, owner directives, and the structured handoff of each turn.
- Only explicit commands write to it. Chat with an assistant never does. Owner notes are directives; deputy notes
  are observations; the kind is derived from the actor, not declared.
- The prompt slice is assembled by code in fixed zones instead of being truncated: goal invariants and owner
  directives; the history and attempt table of the task in trouble; recent events of sibling tasks.

### Turns per task, not per goal

Each task with an open incident gets its own turn, so independent incidents are handled in parallel. Commands on
a task carry that task's expected version; commands that change the plan also carry the plan version, so two
turns that race on the plan cannot both win. A turn must end with a structured handoff: the decision, the
hypotheses ruled out and why, and what the next turn should look at. A turn that ends without one is recorded as
aborted, with the list of commands it ran.

### Loops: detect, diagnose, and do not repeat

The engine computes loop signals deterministically, without a model: repeated finding fingerprints across review
rounds, fixes that do not touch the files a finding names, a tree hash returning to an earlier state, a cause the
worker cannot reach (for example a base conflict a review fixer may not touch), the same failure signature across
different models, and limit or environment errors.

The deputy must classify the cause and act on it:

| Cause | Action |
| --- | --- |
| Model not capable enough | Raise the model, up to the owner's configured maximum |
| Wrong strategy | Change the instructions or the approach |
| Reviewer wrong, or the two sides disagree | Waive that specific finding with evidence; the waiver is listed in the PR |
| Process (Cuesura itself) | Trigger the right mechanism, such as base integration, instead of retrying; file an issue |
| A limit set too low while progress is measurable | Raise the limit |
| Environment out of reach (auth, missing tool, network) | Stop or hand over to the owner |
| No progress after different approaches, or an unclear spec | Fail the task and keep a draft PR |

Every extension is a measured attempt: hypothesis, kind of change, success criterion. There is no total cap on
the deputy, but code enforces three rules: the same action on the same failure signature is refused without new
evidence; each kind of action exhausts naturally (the model cap, a different instruction, a limit raise only with
measured progress); and once every action has been tried for a signature without progress, only "stop" or "hand
over" remain, and the engine fails the task with a draft PR if the turn chooses neither.

### Multi-task goals and the integration branch

Waiting for each step to merge into `main` would stop an overnight chain at every step. Stacked PRs are painful
with squash merges. The design uses an integration branch per goal:

- Each task of the goal is a unit with its own worktree, based on `cusr/goal-<id>`, and runs the full coder →
  gates → reviewer → fixer workflow.
- A unit that passes gates and review is merged by the daemon into the goal branch, and the gates run again on the
  goal branch to catch semantic conflicts after integration. Dependents start once their prerequisite is
  integrated, not merged into `main`.
- The goal opens a draft PR into `main` early so CI runs on every push to the goal branch. A final review covers
  the whole diff, and the owner merges. There is no auto-merge into `main`.

### Plan approved once

For a multi-task goal the deputy proposes a plan: goal and scope, units with acceptance criteria and declared
scope, dependencies and run configuration. The engine computes what can run in parallel. The plan has a version
and hash and is confirmed once. Afterwards the deputy may change order, dependencies, models and instructions;
adding or removing units, changing acceptance criteria or widening scope needs a new approval.

### Coordination across goals stays in the engine

Dispatch uses dependencies, scope and hotspots across the whole project, with no model call. Units in a plan must
declare scope. When two running branches conflict (checked with `git merge-tree`), a fixed rule decides which task
waits. The deputy is called only when the plan itself must change.

### Authority

An actor name is not proof of authority. Each turn gets a token from the daemon; a deputy command is accepted only
if the token matches a running turn, the task belongs to that turn's goal, and the command kind is in the deputy's
permission table. Commands are idempotent by request ID, so a crash in the middle of a turn is safe to replay, and
an incident is reopened after a restart only if the task is still in the same wait.

## Why it was not built

Before implementing this (about eight pull requests, including constitution amendments for merging into the goal
branch, a single plan approval and recorded waivers), the owner ran an off-the-shelf orchestrator agent overnight.
It closed nearly all open issues from one prompt, with every PR green under branch protection. Most of what this
design adds on top of a capable orchestrator is reliability machinery whose value had not been shown in practice,
so the project was archived instead. See the "What we learned" section of the [README](../README.md).
