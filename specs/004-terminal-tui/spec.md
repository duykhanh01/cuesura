# Feature Specification: Interactive terminal interface for `cusr`

> Reflects the design at the time it was written; the code is the source of truth.

**Feature Branch**: `004/tui-spec`

**Created**: 2026-10-31

**Status**: Draft

**Input**: User description: "An interactive in-terminal application (TUI) for Cuesura, in the spirit of
no-mistakes and Bernstein. Type `cusr` to enter the main screen: see the projects, the daemon and the current tasks.
Live monitoring: which task is coding, reviewing, waiting for CI or waiting for the user; which step failed and why.
Select a task to see details: workflow progress, agent/model, logs and the related PR. Keyboard operation: create
tasks, choose the run configuration, answer questions, confirm or cancel; with menus and key hints. Guidance for new
users: know what needs configuring and what the next step is. Focus: open the terminal, glance at it and understand
what the system is doing and what you can do next, with little need to remember command syntax."

## Context and scope

Today the project owner drives Cuesura through `cusr` subcommands; typing `cusr` with no command only gets the error
"no command given". Knowing where a task stands means combining `status`, `task list`, `task explain` and
`inbox`, and remembering IDs, versions, request IDs and digests. This feature adds a full-screen interactive
interface in the terminal, opened with `cusr`, so the user can see at a glance what the system is doing and continue
working with the keyboard.

This is **a new interface surface over existing capabilities**, not a new orchestration capability: every state is
still decided by the daemon and every action still goes through the same service, with the same permission, version
and deduplication checks as the CLI. The interface adds no new task state, exit or permission.

**Out of scope:**

- Web dashboard; access from another machine beyond what terminal/SSH already offers; multiple users.
- A setup wizard that writes configuration; installing or starting/stopping the daemon, runner or harness from the
  interface. The interface only checks and points to the next step.
- Requesting merge, enabling yolo, approving merges, `task retry`, `amend-policy`, group/epic, decider: whatever the
  CLI currently reports as unsupported is not presented by the interface as available.
- AI-suggested run configuration or any LLM call from the interface.
- Editing code or resolving diffs in the interface; notifications outside the terminal; custom key bindings and
  themes.

**v1 scope:** This interface belongs to v1 per [SPEC.md §2.1](../../SPEC.md#21-v1), so it does not conflict with
[constitution](../../docs/constitution.md) principle VIII. The web dashboard remains post-v1.

**Acceptance milestones:** The first milestone covers US1–US5. The read-only part (US1, US2) may be built first, but
on its own it does not meet the milestone. US6 together with FR-029–FR-031, EC-015 and SC-012 belongs to a later
milestone and is not a condition of the first. At the first milestone, FR-001 still applies: when the daemon cannot be
reached or the token cannot be read, the interface still opens, states the reason, offers retry and exit, but has no
step-by-step checklist yet. An empty task list leads to the task creation form.

## Clarifications

### Session 2026-11-01

- Q: Is the TUI part of v1? → A: Yes; SPEC.md and docs/architecture.md were updated for consistency.
- Q: What does the first acceptance release include? → A: US1–US5, with the read-only part possibly implemented
  first; US6 is left for a later milestone.
- Q: What language is the interface text in? → A: English, consistent with the CLI; no localization yet.
- Q: Which projects does `cusr` show on open? → A: All projects within the token's scope, not inferred from the
  current directory; the project filter is always visible (FR-008).
- Q: Can stale data be used for actions? → A: New write actions cannot be sent while data is marked stale; keep the
  input in progress, re-read before allowing a send and never send automatically. Reconciliation of requests with
  unknown outcome still runs (FR-044).
- Q: Does the log automatically move to the new step? → A: Only when following live, and each step has its own log,
  starting with a line naming the step and attempt; when scrolling, paused or reading an older attempt, keep the
  position and signal new activity (FR-014).
- Q: Must confirmation show the whole task content? → A: Yes; the full content of the exact revision must be
  viewable, with long parts scrollable or expandable. If it cannot be read, confirmation is not allowed (FR-026).
- Q: What happens when automatic reconnection attempts run out? → A: Keep the session, the disconnected screen and the
  draft, and wait for the user to choose `Retry connection`; do not start a new retry round automatically. The number
  of attempts and backoff are fixed by the plan. Errors that do not clear on their own stop automatic retries
  immediately (FR-009, FR-039, SC-003).
- Q: When is the profile chosen? → A: Only on the task creation form, because a task's profile is fixed from
  `task.profile` or `cusr.yaml`, not from the run proposal. After that the profile is display-only; mode and bindings
  can still be chosen within the task's valid range (FR-024, FR-025).

### Session 2026-11-04

Trying US1 and US2 showed the interface was hard to read: plain text at a single weight, a flat list of 18 steps, logs
as harness JSON. The answers below fix the presentation; they add no state, action or permission.

- Q: How many lines does a task take on Home? → A: One line, in columns: status symbol, title, project, eight stage
  dots, current activity with mode and PR, time in state. Status is conveyed by its own symbol (FR-035); the status
  name appears in the count line above and on the help screen. The last line of the screen body names all stages of
  the selected task.
- Q: How is workflow progress shown? → A: The steps of `software_dev` are grouped into eight stages triage, prepare,
  code, gates, review, PR, CI, merge; fix and rerun steps belong to the stage they fix, and a stage run multiple times
  shows `×n`. A stage skipped by the mode shows `skipped –` and never carries a `✓` (FR-011). A workflow with unknown
  steps lists each step as the daemon returns it.
- Q: How is task detail laid out? → A: Each section has a ruled heading and label–value columns; sections with
  nothing to say are omitted. ID, version, revision and worktree go into the `Reference` section. Spec IDs do not
  appear in displayed text.
- Q: How does the log read? → A: Like the agent's own transcript: `•` before agent messages and tool calls, `⎿` for
  results, `✻` for session notes. Markdown in agent messages is rendered (bold, code, lists, tables). Records that
  exist only for counting or redraw (thinking token counts, `ui_invalidate`, remaining rate limit) are hidden; unknown
  records still show as compact JSON, and `cusr task logs` still returns the raw records (FR-014).
- Q: Can the log be viewed per step? → A: From 100 columns, the Log screen splits into two columns: the left shows the
  stages vertically, the current work, what is waiting on the user and the portion of log being viewed; the right is
  the log. When narrower, the stages become one horizontal line at the top of the log. Separators name the step in
  words; `t` selects a single step to view.
- Q: What does Enter on Home open? → A: It opens the task on the Log screen above, because the most common questions
  are how far the task has got and what the agent is doing. `d` opens Task detail over the Log screen (wait reason,
  what to do, PR, limits, history); `Esc` or `l` from there returns to exactly where you were reading on the Log
  screen. `Esc` on the Log screen returns to Home.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand the system from one screen (Priority: P1)

The project owner types `cusr` and immediately sees the projects, daemon health and current tasks, along with what
each task is doing. Work that needs them is at the top. The screen updates itself without retyping commands.

**Why this priority**: This is the core of the feature and has value on its own even before any action is possible:
it replaces combining several read commands with a single glance.

**Independent Test**: With a real daemon and a simulated harness, create tasks in every state via the CLI, open
`cusr` in a real terminal and compare the screen with the output of `task list`/`task explain`.

**Acceptance Scenarios**:

1. **Given** a healthy daemon with tasks, **When** the user types `cusr` in a terminal, **Then** the main screen
   shows projects, daemon health, execution slots, the queue and the task list without any arguments.
2. **Given** tasks that are coding, in gates, in review, waiting for CI, waiting for a human, waiting for merge, in
   cooldown and finished, **When** viewing the list, **Then** each task states its current activity in plain words,
   not just a raw state name such as `WAITING`.
3. **Given** there is a question, an unconfirmed run configuration, an escalation awaiting approval or a PR awaiting
   manual merge, **When** opening the main screen, **Then** those tasks are in the "needs you" group at the top,
   along with what to do.
4. **Given** the screen is open, **When** a task changes state due to the daemon, **Then** the screen updates without
   the user pressing anything.
5. **Given** the daemon reports unhealthy, **When** viewing the main screen, **Then** the reason is clear, as is
   whether new work is blocked; no indicator suggests the system is fine.
6. **Given** the daemon connection is lost while viewing, **When** data can no longer be updated, **Then** the
   interface marks the data as stale with the last update time, automatically retries the connection within limits,
   and does not present stale data as current. When attempts run out, the interface keeps the session and the draft
   and waits for the user to choose `Retry connection`.
7. **Given** the user is in the interface, **When** they exit, **Then** the terminal returns to how it was before
   opening; tasks and the daemon keep running unaffected.
8. **Given** `cusr` runs without an interactive terminal or with `--json`, **When** the command is invoked, **Then**
   the output keeps the existing CLI contract exactly; the interface does not open and there is no ANSI or prompt.
9. **Given** there are tasks in several projects within the token's scope, **When** typing `cusr` from any directory,
   **Then** the tasks of all those projects are shown, and the active project filter is always visible on screen.
10. **Given** the token is revoked, unreadable or the daemon's schema is incompatible, **When** the interface updates,
    **Then** it stops automatic retries, states the reason and only retries when the user asks.

---

### User Story 2 - See why a task is in that state (Priority: P1)

From the list, the user selects a task and sees workflow progress, the agent/model used, live logs and the related
PR; if it failed or is waiting, they know why and what the exits are.

**Why this priority**: Knowing "something is wrong" without knowing why still sends the user back to the CLI.
Together with US1, this is the complete read-only monitoring version, so it should come before actions, but it is not
enough to meet the first acceptance milestone.

**Independent Test**: Go through a sample task set covering every reason/detail of [FR-029 of feature
002](../002-task-to-green-pr/spec.md), comparing the detail screen with `task explain`, `task show`,
`task history` and `task logs`.

**Acceptance Scenarios**:

1. **Given** a running task, **When** opening detail, **Then** the workflow steps are shown with steps passed,
   running and remaining. Steps not run under the confirmed mode are marked "not required"; for example, review in
   `direct-pr` is never shown as passed.
2. **Given** a waiting or failed task, **When** opening detail, **Then** the related step, reason, continuation
   condition and exits are shown, matching that task's `task explain`.
3. **Given** a task with attempts, **When** viewing detail, **Then** harness/model/effort per step, turns used and
   remaining, remaining deadline and slot wait time are shown. Unavailable usage is shown as "no data", not 0.
4. **Given** an agent is running, **When** opening the log, **Then** the log streams live; the user can scroll and
   pause without losing position. Lost log segments appear as a clear gap, and an expired follow session reconnects
   automatically at the right position.
5. **Given** a task with a PR, **When** viewing detail, **Then** the PR link, checked head, gate results, CI, review
   per mode and the "green PR" status tied to that head are shown.
6. **Given** a green PR awaiting merge, **When** viewing detail, **Then** the interface states clearly that the user
   must merge on GitHub themselves, with the proposed method and content if any; it does not promise Cuesura will
   merge and does not show the task as done.
7. **Given** a DONE task with `merged_head_unverified` or a cancel request that arrived too late, **When** viewing
   detail, **Then** exactly that meaning is shown, with the two relevant heads; the interface does not present the
   merge as certified or the task as cancelled.
8. **Given** a finished task, **When** viewing detail, **Then** history, logs and evidence are still readable and no
   action reopens the task.
9. **Given** the log is being followed live, **When** the workflow moves to a new step, **Then** the log continues
   into that step, with a separator line naming the step and attempt.
10. **Given** the user is scrolling, paused or reading an older attempt, **When** the workflow moves to a new step,
    **Then** the reading position is kept and the interface signals new activity.

---

### User Story 3 - No keys or syntax to remember (Priority: P2)

Every screen shows the keys usable right then and the action menu for the selected item. The user does not need to
know IDs, versions, request IDs or digests.

**Why this priority**: This is what makes the interface worth using over the CLI, but it only matters once there is
content to navigate from US1 and US2.

**Independent Test**: Someone who has not read the docs moves between the main screen, detail, log, help and exits,
relying only on on-screen hints.

**Acceptance Scenarios**:

1. **Given** any screen, **When** looking at the interface, **Then** the main active keys are always visible,
   including how to go back and how to exit.
2. **Given** a task is selected, **When** opening the action menu, **Then** exactly the actions for that task in its
   current state are shown, each with one sentence on its effect.
3. **Given** typing in an input field, **When** pressing keys that are normally shortcuts, **Then** they are entered
   as text and do not trigger actions.
4. **Given** the full key list is needed, **When** opening help, **Then** all keys are shown by context and closing
   it returns to the same position.

---

### User Story 4 - Handle work waiting on me (Priority: P2)

The user answers agent questions, approves escalations, requests a recheck or cancels a task right in the interface.
Consequential actions always preview their scope and require explicit confirmation.

**Why this priority**: Closes the "see what needs doing and do it" loop, but needs US1–US3 and must preserve the
permission and deduplication guarantees, so it comes after the read-only part.

**Independent Test**: With all three permission levels, perform each action on sample tasks and compare the event
history and attempt/effect counts with the same action done via the CLI.

**Acceptance Scenarios**:

1. **Given** a task with a question, **When** the user enters an answer and sends it, **Then** the answer is
   recorded once and the task continues according to the state returned by the daemon.
2. **Given** the question was just answered elsewhere, **When** the user sends, **Then** they see that the question
   already has an answer and its content; the user's answer is not treated as applied and is not lost before they
   can read the notice.
3. **Given** cancelling a task is chosen, **When** proceeding, **Then** the interface requires a reason and explicit
   confirmation; afterwards it shows the actual stop/reconciliation progress and does not report CANCELLED before the
   daemon determines it. If a merge already happened, it shows DONE with "cancel request arrived too late".
4. **Given** a task in `worktree_changed`, **When** choosing recheck, **Then** the interface warns that this action
   takes the observed directory tree as the task's baseline and reruns the step, shows that change (or states clearly
   it cannot be shown and points to the worktree location), and proceeds only after a separate confirmation.
5. **Given** an escalation awaiting approval, **When** someone with operate permission opens the approve action,
   **Then** the step, rung, reason and remaining limits are shown; approval does not grant turns that have run out.
6. **Given** the token lacks permission for an action, **When** viewing the menu, **Then** the action is shown as
   unavailable with the reason; the interface does not search for another token to get around it.
7. **Given** the task's version changed while the dialog was open, **When** sending, **Then** the action is rejected
   as a conflict, the interface shows the new state and does not resend automatically.
8. **Given** an action was sent without receiving a result, **When** the connection recovers, **Then** the interface
   reports "outcome unknown", reconciles using that same request and creates no second effect.
9. **Given** a task awaiting merge or finished, **When** opening the menu, **Then** there is no merge or retry action;
   if the user wants to redo it, the interface suggests creating a new independent task.
10. **Given** data is marked stale and the user is composing an answer, **When** sending, **Then** the action is
    locked with a reason and the content remains. When updates resume, the interface re-reads the task, shows changes
    if any and waits for the user to send again.

---

### User Story 5 - Create a task and choose the run configuration (Priority: P2)

The user creates a task with a form, optionally choosing a profile right then, then chooses the mode, worker and
reviewer from the options valid for the task, reviews everything and confirms. Tasks prepared by the assistant are
reviewed and confirmed the same way.

**Why this priority**: Completes the journey without remembering syntax. Placed after US4 because the CLI and the
assistant can still create tasks, while handling waits happens daily; and this is the most sensitive point regarding
confirmation.

**Independent Test**: Create tasks using only the interface in both modes, run them to a green PR with a simulated
harness, then check that the confirmation evidence is tied to the correct task, revision and digest of the option set
displayed.

**Acceptance Scenarios**:

1. **Given** the task creation form is open, **When** entering project, title, base branch, description and
   acceptance criteria, **Then** errors are reported immediately at the corresponding field; entered content is not
   lost on errors or when the daemon rejects.
2. **Given** a created task, **When** choosing the run configuration, **Then** the task's resolved profile is shown
   (not changeable) and only the modes and bindings valid for the task are shown, with `when_to_use` guidance if
   declared; there are no free-form choices.
3. **Given** everything is chosen, **When** reaching the review screen, **Then** the full task content per FR-026,
   profile, mode, reason, worker, reviewer if `full-review`, fallback options are shown, and it is stated clearly that
   `direct-pr` has no reviewer.
4. **Given** the review screen, **When** the user has not performed the separate confirmation step, **Then** the task
   does not move to running, even if a timeout has elapsed, an option is preselected or the user presses Enter out of
   habit.
5. **Given** the option set on the daemon changed after being displayed, **When** confirming, **Then** the
   confirmation is rejected; the interface shows the difference and asks for confirmation again.
6. **Given** an assistant-created task with an existing proposal, **When** opening the task, **Then** where the
   proposal came from, its reason and the scope being confirmed (intake, run configuration or both) are clear; the
   choices can be changed before confirming.
7. **Given** a connection with a token not allowed to confirm the run configuration, **When** reaching the
   confirmation step, **Then** proposing is still possible, but the interface states clearly that the user must
   confirm over a trusted connection and does not report the task as confirmed.
8. **Given** the configuration or capabilities are invalid after confirmation, **When** the task returns to PENDING,
   **Then** the diagnosis and what to fix are shown; after fixing, a recheck can be chosen right from the interface.
9. **Given** a task creation was sent with unknown outcome, **When** retrying, **Then** only one task is created.
10. **Given** the daemon created the task but the response was lost and the user exits the interface, **When**
    running exactly the lookup command printed on exit, **Then** the task ID and initial result are shown without
    the old payload; the task count does not increase.
11. **Given** the task content of the exact revision being confirmed cannot be read, **When** reaching the review
    screen, **Then** the interface states the reason and does not allow confirmation, even if a run configuration
    already exists.

---

### User Story 6 - Guidance for new users (Priority: P3)

A new user typing `cusr` with no configuration or with the daemon not running can still enter the interface and see
an ordered checklist of what to do, knowing which steps are done and what comes next.

**Why this priority**: High value the first time but rarely repeated for a user who has finished setup, and the
connection error cases are minimally covered by US1.

**Independent Test**: On a clean machine, create each missing condition in turn and confirm the interface points to
exactly the next step; follow only those instructions until the first task is created.

**Acceptance Scenarios**:

1. **Given** no configuration, the daemon not running or an unreadable token, **When** typing `cusr`, **Then** the
   interface still opens, states clearly what is missing and the next step, rather than just reporting a connection
   error and exiting.
2. **Given** a project exists, **When** viewing the checks, **Then** `doctor` results are shown per item; failed
   items come with the fix command for the user to run themselves, and the interface does not run it.
3. **Given** the user just fixed something, **When** asking for a recheck, **Then** the list updates right away in
   the interface, without exiting.
4. **Given** a condition that cannot be checked yet, **When** displayed, **Then** it is marked "unknown" with a
   reason, not treated as passed.
5. **Given** all conditions pass but there are no tasks, **When** entering the main screen, **Then** the empty state
   leads straight to creating the first task.
6. **Given** first use is over, **When** the environment needs checking again, **Then** this list can be reopened
   from the main screen.

### Edge Cases

- **EC-001 Untrusted content**: Task titles, questions, logs and PR content may contain terminal control characters
  produced by the agent or the repo. These characters MUST be neutralized and cannot fake a confirmation screen,
  change displayed content or send commands to the terminal.
- **EC-002 Small or resized terminal**: Below the minimum size of 80×24 the interface asks for a larger window and
  still allows exit; resizing re-lays out without losing position or input in progress.
- **EC-003 No color**: With `NO_COLOR` or a low-color terminal, every state is still distinguishable by text or
  symbol.
- **EC-004 Multi-byte text**: Vietnamese, CJK and emoji do not break columns; truncation follows display width, and
  full content is always viewable on the detail screen.
- **EC-005 Many tasks**: More than one page (100) of tasks can still be browsed; counts must not be derived from the
  first page alone. Finished tasks are collapsed by default and can be expanded.
- **EC-006 Concurrent callers**: When two interface sessions, the CLI or the assistant act on the same task, the
  result follows the daemon; the later party sees a conflict and the new state.
- **EC-007 Daemon restart**: An open session reconnects automatically within the limits of FR-009 and re-reads
  state; the log continues from the position already read. A running task is not reported lost just because the
  daemon restarted.
- **EC-008 Permissions change mid-session**: When a token is revoked, new requests report missing permission; the
  interface does not keep the action as still usable and does not try other token sources.
- **EC-009 Project-scoped token**: Only projects and tasks the token can read are shown, with a note that this is the
  token's scope, not the whole system.
- **EC-010 Version skew**: If the daemon returns data in an unsupported schema, the interface reports
  incompatibility; it does not guess the meaning and display it.
- **EC-011 Excessive logs**: A flood of logs does not freeze keys or grow memory without bound; older parts that leave
  the buffer can still be re-read by position.
- **EC-012 Abrupt exit**: Ctrl-C, SIGTERM, SIGHUP or an internal error all return the terminal to its original state.
  Ctrl-C does not cancel tasks. If actions with unknown outcome remain, even on a normal exit, the interface prints to
  stderr the request ID and the exact FR-041 lookup command for each action, after restoring the terminal so the line
  is not lost with the full-screen view, and exits with code 3. When there is no terminal left to print to (SSH
  dropped) or the process is killed, the user reconciles using the task list and task history; the interface does not
  write payloads to a file to compensate (FR-038).
- **EC-013 Task changes state while being viewed**: The selection is kept by task, not by row position, so reordering
  does not make an action land on a different task. An open menu that is no longer valid is refreshed.
- **EC-014 Worker in sandbox**: Workers have no token and cannot see the data dir, so they only get connection errors
  like any other client; the interface opens no new path for workers.
- **EC-015 Waiting on `doctor`**: Long environment checks do not block navigation or exit, have a time limit and
  report clearly when they time out.

## Requirements *(mandatory)*

### Functional Requirements

**Startup and compatibility**

- **FR-001**: `cusr` with no subcommand or option, when both input and output are interactive terminals, MUST open
  the interactive interface, even when the daemon is not running or there is no configuration. `TERM=dumb` or an unset
  `TERM` is not considered an interactive terminal.
- **FR-002**: Every other invocation MUST keep the CLI contract unchanged: subcommands, `--help`, `--version`,
  `--json`, non-terminal input or output (pipe, script, assistant, `TERM=dumb`). Output, exit code and the absence of
  ANSI or prompts are unchanged; `cusr` with no arguments outside a terminal still returns the current error.
- **FR-003**: The interface MUST resolve the connection exactly like subcommands (data dir, token file, environment
  variables). Having a terminal MUST NOT be used as evidence of permission. Token content MUST NOT be displayed.
- **FR-004**: Exiting the interface by any path MUST return the terminal to its original state and not affect tasks,
  the daemon or the runner.

**Main screen and live monitoring**

- **FR-005**: The main screen MUST show the projects within the token's scope, daemon health, execution slots, the
  queue and the task list.
- **FR-006**: Each task MUST show title, project, state, current activity in plain words, time in that state, the
  execution mode if any and the PR if any.
- **FR-007**: Tasks needing the user MUST be grouped separately at the top, stating what to do and the count. A task
  is in this group only when continuing depends on the user per `task explain`. Tasks waiting for CI, cooldown or a
  slot within limits MUST NOT be in the group just because the user could cancel them. Within each group, the most
  recently created task MUST be at the top.
- **FR-008**: On open, the interface MUST show all projects within the token's scope; the current directory MUST NOT
  narrow this scope. The user MUST be able to filter by project and state, and browse all tasks via pagination. The
  active project filter MUST always be visible.
- **FR-009**: The interface MUST update itself on a bounded interval and show the last update time. When updates
  fail, data MUST be marked stale, and the interface reconnects automatically with capped backoff and a bounded
  number of attempts. When attempts run out, the interface MUST keep the session, the disconnected screen and the
  input in progress, MUST NOT start a new retry round automatically, and waits for the user to choose
  `Retry connection`; each choice starts a new retry round with the same limits. Errors that do not clear on their own
  (token revoked or unreadable, incompatible schema) MUST stop automatic retries immediately, state the reason and
  only retry when the user asks.
- **FR-010**: An unhealthy daemon MUST be shown with the reason taken from health, including new work being held or
  claims being unknown; the interface MUST NOT infer a health state different from the daemon's.

**Task detail**

- **FR-011**: Task detail MUST show workflow progress from recorded data, according to the confirmed mode; steps not
  required MUST be distinct from steps passed.
- **FR-012**: Wait reason, continuation condition, exits, failure reason, blockers and remaining limits MUST match
  `task explain`. The interface MUST NOT have its own logic inferring state or exits.
- **FR-013**: Detail MUST show harness/model/effort per step, requested and invoked turns, escalations and usage.
  Usage MUST distinguish `reported`, `estimated`, `unavailable`.
- **FR-014**: Logs MUST be viewable live and by position, scrollable and pausable, readable per past attempt, with
  automatic follow-session reconnection and visible data gaps; following logs MUST NOT occupy a slot. When following
  live, the log MUST switch to the new step's own log, starting with a line naming the step and attempt; the previous
  step is viewed again with `←`. When scrolling, paused or reading an older attempt, the position
  MUST stay put and the interface signals new activity; new log content MUST be re-read by cursor, not accumulated in
  a buffer beyond the cap of FR-039.
- **FR-015**: Detail MUST show event history in committed order and PR evidence: link, head, base, gate results, CI,
  review per mode, green validity, proposed merge method and content, merge commit and the unverified-merge marker.
- **FR-015.01**: Detail MUST show what the task asks for, read from `task content`: description, requirements and
  acceptance; in technical-info mode also constraints, out_of_scope and base branch. A long description MAY be
  truncated in normal mode if it states how many lines remain and how to see it all. Content is re-read when
  `revision` changes; read errors MUST be shown right in that section and MUST NOT lock write actions, since this
  content is view-only.

**Actions**

- **FR-016**: Displayed actions MUST be based on the actions the daemon allows for the task in its current state,
  with their effects. Actions without sufficient permission MUST be shown as unavailable with a reason.
- **FR-017**: The interface MUST support: creating tasks, proposing a run configuration, confirming intake,
  confirming the run configuration, answering questions, approving escalations, rechecking and cancelling, within the
  token's permissions.
- **FR-018**: Every write action MUST go through the same service and the same permission, version and deduplication
  checks as the CLI; the user MUST NOT have to enter IDs, versions, request IDs or digests.
- **FR-019**: Each logical action MUST keep one request ID across resends. Not receiving a result MUST be reported as
  "outcome unknown" and reconciled; MUST NOT create a new request that could duplicate the effect. Automatic
  reconciliation and resending MUST have a cap; when the cap is reached, stop, keep the action in the unknown state and
  wait for the user to request a recheck. Exiting before reconciliation finishes follows EC-012.
- **FR-020**: The interface MUST distinguish "accepted" from "completed", and always show the actual state returned by
  the daemon after an action.
- **FR-021**: Opening screens, refreshing and navigating MUST NOT create mutations; recheck in particular MUST only run
  when the user asks.
- **FR-022**: Cancelling a task and rechecking in `worktree_changed` MUST require a preview of consequences and a
  separate confirmation, not a single key. Cancel MUST record a reason.
- **FR-023**: The interface MUST NOT have merge, merge approval, yolo, retry or amend-policy actions. When those are
  relevant, the interface MUST point to the actual exits: merge manually on GitHub then observe or recheck, or create
  a new independent task.

**Task creation and run configuration**

- **FR-024**: The task creation form MUST have project, title, base branch, description, acceptance criteria;
  optionally dependencies (chosen from the task list, not by entering IDs), priority and profile. Errors MUST be
  reported per field and entered content MUST be kept when rejected. Leaving the form with content MUST ask again.
- **FR-025**: The user MUST be able to see the task's resolved profile (display-only) along with the modes and
  bindings valid for that task, with declared `when_to_use` guidance. When the list cannot be read, the interface MUST
  say so clearly and MUST NOT guess options.
- **FR-026**: Before confirming intake or the run configuration, the review screen MUST show the full content of the
  exact revision being confirmed: project, base branch, title, description, requirements, acceptance, constraints,
  out_of_scope; together with profile, mode, reason, worker, reviewer if any and fallback options; and state clearly
  the scope being confirmed (intake, run configuration or both). Long parts MUST be scrollable or expandable; summaries
  or truncation MUST NOT replace the full content. An empty list MUST be shown as none, distinct from not yet read. If
  the content of the exact revision cannot be read, confirmation MUST NOT be allowed.
- **FR-027**: Confirming the run configuration MUST be a separate, deliberate user action on the review screen, bound
  to the digest of the exact option set displayed. It MUST NOT be confirmed by a timeout, by a preselected value or by
  an Enter key on a default focus.
- **FR-028**: An option set that changes after being displayed MUST invalidate the old confirmation; the interface
  MUST show the difference and ask for a new confirmation. A token not allowed to confirm MUST receive a clear notice,
  with no workaround.

**New user guidance**

- **FR-029**: The interface MUST have an ordered checklist of the conditions for being usable: configuration, daemon,
  token, project, environment per `doctor`, first task; each item has a state of passed, failed or unknown, and
  states one next step.
- **FR-030**: Guidance MUST be read-only and not write configuration, install or start anything itself. Suggested
  commands MUST be commands that exist in the running build or in actual operating documentation; MUST NOT introduce
  commands that do not exist yet.
- **FR-031**: The checklist MUST appear automatically when basic conditions are not met, be rechecked without
  exiting and be reopenable from the main screen.

**Navigation and display**

- **FR-032**: Every function MUST be fully usable with the keyboard; a mouse is not required.
- **FR-033**: Every screen MUST always show hints for the active keys, have an action menu for the selected item and
  a context-sensitive help screen. Back, exit and help keys MUST be consistent across screens.
- **FR-034**: When entering text, ordinary keys MUST go into the input; dialogs MUST have a way to leave without
  sending.
- **FR-035**: State MUST not rely on color alone; the interface MUST respect `NO_COLOR`, adapt to resizing, support at
  least 80×24 and measure width correctly for multi-byte text.

**Safety and limits**

- **FR-036**: The interface MUST read and write business data only through the daemon: it does not open the state
  store and does not call LLMs, GitHub or harnesses. All displayed content MUST be built by code from recorded data.
  Only the guidance shown when the daemon is not running may read the local files needed for diagnosis, without
  reading secret content beyond checking the token file.
- **FR-037**: Content from agents, repos or external sources MUST have control characters neutralized before display
  (EC-001).
- **FR-038**: The interface MUST NOT expose secrets: it only displays data the daemon has redacted and does not write
  business content to its own files or logs.
- **FR-039**: Refresh rate, number of automatic reconnection attempts, per-request timeout and the log buffer MUST be
  capped. The specific number of attempts and backoff are fixed by the plan, sufficient to meet SC-003 within the
  automatic retry window. A long-open session MUST NOT increase daemon load or memory without bound.
- **FR-040**: Every new read path needed for this feature (Dependencies section) MUST be read-only, check permission
  and project scope in the service, and have a machine-readable contract like the CLI, so the interface has no
  capability that the CLI and assistant cannot verify.

**Looking up actions after exit**

- **FR-041**: `cusr request show REQUEST_ID` MUST return the result of a mutation from the request ID alone, even
  after the sending session has exited and the payload is gone. The command MUST be read-only: it takes no payload,
  does not run or resume the action, and creates no event. The command has `--json` and follows the CLI contract:
  found exits 0 even if the action was rejected; not found exits 4.
- **FR-042**: The result MUST state the action type and one of these states:
  - `completed`: with the first stored result, success or rejection.
  - `in_progress`: the daemon is processing this request.
  - `interrupted`: the daemon accepted it but is no longer processing it (for example a restart midway) and has no
    result; the effect may have partially happened. The command MUST ask to re-read the task before sending a new
    request.
  - Not found: the daemon has no record the token can read, at lookup time. MUST NOT be presented as the action
    certainly not having happened.

  A task ID MUST only appear when that task actually exists: an ID pre-allocated when `task_add` was accepted MUST NOT
  be presented as a created task.
- **FR-043**: Lookup MUST require read permission and only return requests of the exact actor in the token, with a
  project within the active token's scope. Another actor, a project out of scope or an undeterminable project with a
  project-scoped token MUST get exactly the "not found" response, without revealing whether the request exists.

**Actions on stale data**

- **FR-044**: While data is marked stale (FR-009), the interface MUST lock sending new write actions and state the
  reason; if only one task's data is stale, lock write actions on that task. Navigation, reading existing data,
  composing content and exiting remain usable. Reconciliation of unknown-outcome requests per FR-019 MUST NOT be
  locked. Input in progress MUST be kept in the session, in memory only (FR-038). When updates resume, the interface
  MUST re-read the task before allowing a send; if the task or option set changed, it MUST show the change and require
  confirmation again. The interface MUST NOT send the draft automatically. This lock does not replace the version and
  digest checks in the daemon.

### Key Entities *(include if feature involves data)*

- **Interface session**: transient state within one opening: connection, screen, selected item, filters, last update
  time. Not durable, not a source of truth.
- **Task's current activity**: a plain description built from the recorded status, wait, step and attempt; a
  presentation, not a new state.
- **Item needing action**: a task with an exit that needs the user (question, confirmation, approval, manual merge,
  configuration fix), derived from daemon data.
- **Run configuration options**: the task's resolved profile, valid modes and bindings, `when_to_use` guidance, the
  digest of the chosen set.
- **In-flight action**: request ID, payload, expected version and state (sending, accepted, rejected including
  conflict, outcome unknown) within the session.
- **Request lookup result**: state per FR-042, derived from the deduplication record and whether the daemon is
  processing it; not a task state.
- **Onboarding check item**: one condition for being usable, a passed/failed/unknown result, evidence source, next
  step.

## Success Criteria *(mandatory)*

All criteria MUST be checked in a real terminal or pseudo-terminal with a real daemon; the harness may be simulated
unless stated otherwise. Standalone screen-rendering tests are not used to claim a pass.

### Measurable Outcomes

- **SC-001**: For 100% of the reasons/details of FR-029 of feature 002, from opening the interface the user sees
  where the task is, why and what the exits are without running any other command; the content matches
  `task explain` in 100% of samples.
- **SC-002**: With a system of 100 tasks, the main screen has data within 2 seconds of typing `cusr`.
- **SC-003**: 95% of task state changes appear on screen within 3 seconds, without pressing a key. If the daemon
  becomes ready again while still within the automatic retry window, the interface has fresh data within 10 seconds
  of that moment, without pressing a key. If attempts have run out, the interface does not reconnect automatically and
  has fresh data within 10 seconds of the user choosing `Retry connection` with the daemon ready. At no time is stale
  data shown as current.
- **SC-004**: Someone who knows Cuesura completes the journey of creating a task, confirming the configuration,
  answering a question, following to a green PR and seeing DONE after a manual merge without using any `cusr`
  subcommand; total interaction time (excluding agent run time) is under 3 minutes. At least one run with each real
  harness in both modes, recorded separately from simulated runs.
- **SC-005**: Someone who has not read the docs reaches task detail, log, help and exits on the first try, relying
  only on on-screen hints, within 2 minutes.
- **SC-006**: 100% of the existing CLI contract tests pass unmodified; every invocation without a terminal or with
  `--json` keeps its output and exit code.
- **SC-007**: For every action at the three permission levels, the permission result, events and effect count are
  identical to the same action via the CLI; resending 2–5 times and losing the connection after sending all yield
  exactly one logical effect.
  Test scope: `operate` and `admin` are tested through a real daemon, with the `assistant` and `owner` actors. The
  `read` level is not tested through a real daemon because the daemon only accepts those two actors
  ([ADR 0011](../../docs/adr/0011-declared-actor-instead-of-tokens.md), issue 207 closed "not planned"). The `read`
  level is tested in the permission table (`test/unit/application/authz.test.ts`) and in the TUI reducer, where every
  write action is dimmed and cannot be opened.
- **SC-008**: In seeded, reproducible random key testing (at least 10,000 keys per screen), there is no case of
  confirming the run configuration, cancelling a task or rechecking `worktree_changed` without passing through the
  review screen and the separate confirmation step.
- **SC-009**: A session open for 1 hour without interaction creates 0 new events, 0 agent turns, 0 LLM tokens and
  occupies no execution slot.
- **SC-010**: 100% of content samples containing control characters do not change screen content outside their
  display area and cannot send commands to the terminal.
- **SC-011**: The terminal returns to its original state on 100% of exit paths: normal exit, Ctrl-C, SIGTERM, SIGHUP
  and internal error; tasks continue in 100% of samples. A daemon crash is not an exit path: in 100% of samples, the
  interface stays open, keeps input in progress and shows the disconnected screen.
- **SC-012**: On a clean machine, for each missing condition, the interface points to exactly the next step in 100%
  of samples; following only those instructions, the user creates the first task. 100% of suggested commands exist in
  the running build.
- **SC-013**: A session open for 8 hours with continuous logs does not freeze keys, does not grow memory
  continuously, and key response latency stays under 200 ms for 95% of presses.
- **SC-014**: With failure samples on a real daemon (task created then response lost; action rejected then response
  lost; daemon dies before and after writing the task but before storing the result; nonexistent request; another
  actor; project out of scope), the user exits the interface then runs the printed command verbatim or the lookup
  command with the sample's ID: 100% of samples return the correct FR-042 state, task, event and attempt counts are
  unchanged after the lookup, and the two permission samples are indistinguishable from a nonexistent request.
- **SC-015**: In samples of connection loss and read errors while composing, no new request ID reaches the daemon
  while data is stale or before the first re-read after recovery. In 100% of samples, input in progress remains intact
  and no action is sent unless the user sends again.
- **SC-016**: With a sample task with long content in an 80×24 terminal, 100% of FR-026 fields are fully viewable and
  match the recorded content of the exact revision. With samples where content cannot be read or the revision has
  changed, 0 confirmations are recorded.

## Assumptions

- The user is a project owner on Linux/Ubuntu or WSL2 per the constitution's scope; it works over SSH and tmux since
  both are ordinary terminals.
- The interface runs with the caller's own connection. For a same-UID process with a full shell, the token map is not
  a permission boundary ([deploy/README.md](../../deploy/README.md)); the interface neither improves nor worsens this
  boundary. The assistant keeps using the CLI `--json` and the [`cusr` skill](../../skills/cusr/SKILL.md), and does not
  drive the interface.
- Interface text is English, consistent with existing CLI messages, per the decision in Clarifications; localization
  is out of scope.
- no-mistakes and Bernstein are only experience references (live monitoring of a pipeline or multiple agents in a
  terminal), and do not constrain layout or features. Permissions and confirmation are decided by the constitution.
- The daemon is run by the operator per [deploy/README.md](../../deploy/README.md). The interface does not change the
  limits of feature 002 (one execution slot, manual merge, no retry); when those limits are relaxed in a later
  feature, the interface displays according to real data rather than assuming in advance.
- PR 1 (spec 003, GitHub issue and Telegram) is not merged and holds number 003, so this feature takes number 004.
  This feature does not depend on it; tasks and answers from other channels only appear as data.
- The specific refresh interval, data update mechanism, interface library and detailed layout are decided by the
  plan, within the limits of SC-002, SC-003 and the constitution. Adding a dependency needs justification per
  principle VIII.

### Dependencies

Checked against current code on `main`, the following read-only capabilities **do not exist yet** and must be added
to meet the spec:

| Need | Current state | Related requirements |
| --- | --- | --- |
| List projects within the token's scope | No command or query; `doctor` and `task add` must know the project name in advance | FR-005, FR-024, FR-029 |
| Resolved profile, valid modes and bindings per task, and `when_to_use` | Present in configuration but not readable via the CLI (the [`cusr` skill](../../skills/cusr/SKILL.md) says so); profile and bindings also depend on the task and `cusr.yaml` | FR-025 |
| Current step, mode and time in state, at list level | `task list` only returns status, wait code, version, priority, PR, head; `task show` has the step but must be called per task | FR-006 |
| A task's workflow step list by mode | `task show` and `task explain` only return the current step and steps that have attempts | FR-011 |
| Viewing the changes of `worktree_changed` | No path to read the diff via the daemon. The first milestone does not add this read path and uses the option already allowed by US4 item 4: state clearly it cannot be shown and point to the worktree location | FR-022, US4 |
| Looking up a mutation result by request ID after the client exits | `command_ledger` has actor, type, task, state and result but no read command or query, and does not store project or payload. An `admitted` record after a crash only resumes when the exact payload is resent, so it is not considered in progress. `task show`/`history` need a task ID the client does not know if the `task add` response is lost | FR-041, FR-042, FR-043, EC-012, SC-014 |
| Reading task content directly by revision | `task show` only returns `title` from the task content. `task history` already returns full content in the `TaskCreated` and `TaskRevised` payloads, but requires walking events; there is no direct read path by revision. The plan decides between using history or adding a query | FR-026, US5, SC-016 |
| Logs per attempt | `task_logs` only filters by task; records have `operation_id` and `step` but no attempt. Client-side filtering would also have to read from the start of the log through pages of at most 200 records. The plan decides whether to add a field, a filter parameter or keep client-side filtering | FR-014, US2 |
| Diagnosis when the daemon is not running | The CLI only reports a connection error; the configuration path is decided by `cusrd --config` so the client does not know it | FR-029 (later milestone) |

The plan MUST re-verify this table together with the CLI/daemon contracts,
execution modes and [glossary](../../GLOSSARY.md) before designing.
