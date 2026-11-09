# Feature Specification: Deterministic orchestration core

> Reflects the design at the time it was written; the code is the source of truth.

**Feature Branch**: `001-deterministic-core`

**Created**: 2026-10-27

**Status**: Planned

**Input**: User description: "Cuesura's deterministic orchestration core (the "Core" milestone in SPEC.md §19): domain
and canonical task schema, a cusr.yaml loader producing immutable snapshots/revisions, pure decide/evolve, a store with
event log/projection/outbox/timers and trigger dedup, FrozenPolicy with role bindings, escalation ladder and budget,
plus test evidence for the invariants belonging to the decision layer and the store layer. No real agent calls yet,
no runner/worktree/GitHub."

## Context and scope

This is Cuesura's first feature, corresponding to the "Core" milestone in [SPEC.md §19](../../SPEC.md). Every
later feature (runner, worktree, GitHub, recovery, CLI) builds on the three capabilities this feature provides:

1. Turn user and repo configuration into a validated, hashed **frozen policy** that does not change for the
   whole of a task revision.
2. A **decision core** that chooses the next step, the wait reason, the model rung and the effect requests
   solely from recorded data, without calling an LLM.
3. A **durable state store** that accepts each signal (trigger) logically exactly once and writes the event,
   derived state, pending effects and timers in a single atomic write.

This feature does **not** run real agents, does not create runners, worktrees, commits/pushes/PRs/merges, and has
no daemon, CLI or Telegram/GitHub channel. Results from agents, gates, CI and external effects are fed in as
pre-recorded signals (fixtures) to verify the core's behavior.

## Clarifications

### Session 2026-10-27

- Q: Is an agent turn that has been requested but has not run yet charged against the budget? → A: Distinguish
  reserved budget from used budget. If it certainly has not run, release the reservation; if the agent call is
  confirmed, count it as used; if unclear, keep the reservation until reconciliation completes (FR-022).
- Q: When the user edits the request while the coder is running, where is the new revision applied? → A: Record it
  immediately, let the current attempt finish, and block the next business step. The "safe boundary" is when the
  attempt has finished and the related effects have known outcomes; at that point the user chooses one of the three
  options in SPEC.md §5.3. Cancelling the attempt immediately is a separate operation (FR-011).
- Q: If a cancel request arrives after the merge request has been sent and reconciliation shows the PR has been
  merged, what state is the task in? → A: DONE, with a record that the cancel request arrived too late. Reverting the
  change is a separate revert process (FR-018).
- Q: Does feature 001 execute decider modes? → A: No. Feature 001 only executes `human` mode; the `agent`,
  `agent_if_confident` and `agent_review` modes are explicitly rejected when freezing the policy. The decider is a
  separate feature (FR-039).
- Q: When the user chooses to apply a new revision while the task is waiting to merge, which step does the task go
  back to? → A: Preserve the existing diff, re-triage, then go through Code → Gates → Review → CI again before merge.
  Keep the used budget, model rung and task deadline; if limits are exhausted, wait for a human. Do not use evidence
  from the old revision to approve the new revision (FR-040).
- Q: How is a valid workflow handled when it is not the default software development workflow? → A: Allow config
  validation, but refuse to freeze the policy for execution with error `unsupported_workflow` and keep the task in
  PENDING; do not run the default workflow in its place (FR-041).

## User Scenarios & Testing *(mandatory)*

The primary users are the **project owner** (who runs Cuesura on their own machine) and the **developers of the
following features**, who need a core proven correct before wiring it to agents and external systems.

### User Story 1 - Validate configuration and freeze the policy (Priority: P1)

The project owner writes the user configuration and the repo's `cusr.yaml` (roles, model bindings, workflows,
profiles, pools, gates, escalation ladder, budget). The system reads, normalizes and validates the configuration. If
it is wrong, the project owner gets a list of errors pointing to the exact file, line, column and cause. If it is
correct, the system produces a hashed frozen policy sufficient for every later step to decide without rereading the
configuration.

**Why this priority**: Without a validated policy the decision core has no valid input. Configuration errors caught
early are far cheaper than errors discovered while an agent is running.

**Independent Test**: Run sets of valid and invalid sample configurations through the config validator; compare the
returned errors with the expected errors and compare the hashes of equivalent configurations.

**Acceptance Scenarios**:

1. **Given** a configuration with a workflow where a transition points to a nonexistent step, **When** the project
   owner validates the configuration, **Then** the system rejects it and reports the file:line:column of that
   transition along with the missing step name.
2. **Given** a workflow with a review → fix loop without a count limit, **When** validating, **Then** the system
   rejects it and points out the unbounded cycle.
3. **Given** two configurations that differ only in key order and formatting, **When** freezing the policy,
   **Then** the two frozen policies have the same hash.
4. **Given** a valid configuration, **When** the project owner edits the configuration file after the policy has
   been frozen for a task, **Then** that task's policy does not change; only new tasks or approved amendments use
   the new configuration.
5. **Given** an escalation ladder with a rung that cannot be reached within the workflow's turn limit, **When**
   validating, **Then** the system reports an unreachable-rung error.
6. **Given** an amendment request that only states an actor name, or carries a permission context with `operate`
   but not `admin`, **When** the request is processed, **Then** the system rejects it for lack of permission; the
   task's policy, revision and budget remain unchanged, and no amendment event is recorded.
7. **Given** the same key declared in a toolchain pack, in `cusr.yaml` and in an override at task creation,
   **When** merging configuration, **Then** the final value follows FR-001: the project wins over the pack; the task
   override is applied only when the profile allows that key and it does not widen permissions beyond the caller's;
   keys the repo has no authority over (roles, models, policy, permissions) in `cusr.yaml` are reported as errors
   instead of being silently applied.
8. **Given** a task whose execution context has been frozen, **When** the request content or an original attachment
   changes afterwards, **Then** the frozen context keeps its content and hash; the change only enters via source
   drift and a new revision.
9. **Given** a workflow declaring decision mode `agent_review` for a decision point, **When** validating the
   configuration, **Then** the system reports that this mode is not yet supported; **When** freezing the policy for a
   task using that workflow, **Then** the task is in PENDING with a reason and no decision point is switched to
   `human`.
10. **Given** a configuration that additionally declares a valid workflow other than the default software
    development workflow, **When** validating the configuration, **Then** that workflow is accepted; **When**
    freezing the policy for a task using that workflow, **Then** the system returns error `unsupported_workflow`, the
    task is in PENDING and no step of the default workflow is run.
11. **Given** a configuration with workflow A using only `human` mode and workflow B using `agent` mode, **When**
    validating the configuration, **Then** the configuration is valid, with a note that B is not yet supported;
    **When** freezing the policy for a task using A, **Then** it succeeds; a task using B is in PENDING with a reason.

---

### User Story 2 - Create a canonical task and decide the next step deterministically (Priority: P1)

The project owner (via the programmatic interface or this feature's simulator) submits a task request. The system
normalizes it into a canonical task, validates acceptance and dependencies, then moves the task through PENDING,
READY, RUNNING, WAITING and terminal states following the default software development workflow. On each signal
(simulated agent result, gate, review, CI, user answer, timer), the decision core returns new events and the effects
to perform. The same input always yields the same result.

**Why this priority**: This is the product's core value: orchestration in code, explainable and reproducible, with no
token cost. Every later feature only executes what the core has decided.

**Independent Test**: Replay a pre-recorded signal sequence for a task; check that the event sequence, effects and
final state match the expected result, and that a second replay yields a byte-for-byte identical result.

**Acceptance Scenarios**:

1. **Given** a task request without acceptance criteria, **When** the task is created, **Then** the task is in
   PENDING with reason `needs_info` and there is no agent launch effect.
2. **Given** a task depending on another task that is running, **When** the task is created, **Then** the task is in
   PENDING with reason `dependency`; when the prerequisite is DONE, the task moves to READY; when the prerequisite is
   FAILED, the task keeps waiting with an explanation.
3. **Given** a task at the code step, **When** a valid agent result with `status: done` arrives but a required gate
   fails, **Then** the task does not pass the step; the core requests the next fix step within the turn limit.
4. **Given** an agent result reporting `needs_input`, **When** the signal is processed, **Then** the task moves to
   WAITING with reason `human_input` and the question is recorded; the first valid answer resumes the task.
5. **Given** the same state, policy and signal sequence, **When** running the decision core twice, **Then** both
   runs produce the same events, the same effects and the same final state.
6. **Given** a task already in DONE, FAILED or CANCELLED, **When** a new signal or retry request arrives, **Then** the
   old task does not reopen; a retry creates a new task linked to the source task.
7. **Given** the task's outbox still holds an agent launch effect not yet claimed for execution, **When** a cancel
   request is processed, **Then** that effect is invalidated in the same write, no later claim can start it, and no
   new business effect is created.
8. **Given** a task with one started effect and one effect with outcome `unknown`, **When** a cancel request is
   processed, **Then** the task does not become CANCELLED yet; the system only creates attempt-stop and
   reconciliation effects, and the task becomes CANCELLED after both effects have reconciliation outcomes.
9. **Given** a merge request had been sent when the cancel request arrived, **When** reconciliation confirms the PR
   has been merged, **Then** the task becomes DONE and the history clearly records that the cancel request arrived
   too late; no revert effect is created automatically.
10. **Given** the coder is running on revision 1, **When** the user edits the request, **Then** source drift is
    recorded immediately; the current attempt is allowed to finish; once the related effects have known outcomes, the
    task waits for the user to choose, and no attempt, publish or merge based on revision 1 is started in the
    meantime.
11. **Given** a task waiting to merge with a review approve and green CI for revision 1, **When** the user changes
    the acceptance and chooses to apply revision 2, **Then** the existing diff is kept and the task goes through
    Triage → Code → Gates → Review → CI again; the approve and CI of revision 1 are not used to merge revision 2; the
    number of turns used, the model rung and the task deadline do not change.
12. **Given** the task in scenario 11 has only one agent turn left, **When** more turns are needed to get through
    Code → Review, **Then** the task waits for a human decision instead of extending itself or skipping steps.
13. **Given** a revision 1 publish effect is already in the outbox but not dispatched, **When** source drift is
    recorded and then a claim of that effect is requested, **Then** the claim is rejected and the effect keeps
    waiting for dispatch; if the user chooses to continue revision 1 the effect can be claimed; if they choose to
    apply revision 2 the effect is invalidated and the reservation is released.
14. **Given** review approve and CI for head H, with expected required checks A and B, **When** the CI signal only
    has A = success, **Then** the core does not request merge and the task waits for CI. **Given** both A and B
    succeed but evidence shows H does not contain the current base tip, **When** considering merge, **Then** the core
    does not request merge and the task waits.

---

### User Story 3 - Record signals durably and exactly once (Priority: P2)

Every signal entering the system (including duplicates or resends after a process death) is recorded atomically:
duplicate check, event write, derived state update, pending effects and timers all succeed together or not at all.
Derived state can always be rebuilt from the event log.

**Why this priority**: This is the foundation for crash recovery and for preventing repeated side effects in later
features. It comes after P1 because the decision core can be verified first in pure form.

**Independent Test**: Run a signal sequence containing duplicate signals with process interruptions at random points
during writes; after each interruption, reopen the store and check there are no half writes, no duplicate events,
and that state rebuilt from the log matches the stored state.

**Acceptance Scenarios**:

1. **Given** a signal that has already been accepted, **When** the same signal (same dedup key) is resent,
   **Then** there are no new events, effects or timers; the system returns the result of the first acceptance.
2. **Given** the process is interrupted while writing a signal, **When** the store is reopened, **Then** either the
   whole signal has been written or no part of it has.
3. **Given** a command based on an old state version, **When** the command is sent after the state has changed,
   **Then** the command is rejected as a conflict and changes nothing.
4. **Given** a store with the event logs of many tasks, **When** all derived state is rebuilt from the log, **Then**
   the result matches the stored state 100%.
5. **Given** an effect already recorded for a logical operation, **When** the core requests the same operation
   again, **Then** the effect reuses the same idempotency key and no second effect is created.
6. **Given** a timer that is due, **When** the timer is consumed, **Then** it produces only one logical signal, even
   if reprocessed after a process death.
7. **Given** a publish, PR creation or agent launch that succeeded externally but the process died before recording
   the result, **When** reconciliation returns a complete canonical result, **Then** the evidence is recorded and the
   workflow proceeds to the correct step; **When** reconciliation reports success but lacks required data, **Then**
   the effect stays `unknown` and the task waits for reconciliation.
8. **Given** a signal with key K for task A has been accepted, **When** the same key K and the same signal content
   are sent for task B, **Then** the system returns a conflict and does not return task A's result.

---

### User Story 4 - Escalate the model and spend budget per the approved policy (Priority: P2)

When a code, review or fix step fails, the core classifies the failure and decides to retry, wait or move up a rung
according to the ladder in the frozen policy. Every agent call and every automated decision-maker (decider) call is
charged against the budget. When the ladder, the turns or the deadline run out, the task waits for the user to decide.

**Why this priority**: This is the mechanism that keeps costs predictable and keeps control with the user. It needs
the decision core from Story 2 first.

**Independent Test**: Replay sequences of failure results with different error signatures under sample policies;
check that the chosen rung, the number of turns used and the wait reason match an expected table.

**Acceptance Scenarios**:

1. **Given** two consecutive quality failures with the same signature at the same rung, and the next rung is `auto`,
   **When** the second failure signal is processed, **Then** the core chooses the next rung without waiting for
   approval.
2. **Given** the next rung is `needs_approval` and there is no valid approval, **When** escalation is needed,
   **Then** the task moves to WAITING with reason `approval` and no new attempt starts.
3. **Given** a failure caused by a rate limit or an infrastructure error, **When** processed, **Then** the quality
   failure counter does not increase and the model is not escalated; the task waits on a timer or retries at the same
   rung within limits.
4. **Given** a task that has used all its allowed agent turns, **When** a new attempt is needed, **Then** there is no
   new attempt; the task waits for the user's decision with a clear reason.
5. **Given** a task returning to a step that already ran at a high rung, **When** that step runs again, **Then** the
   rung does not drop; and a step that has not run yet starts at that step's own floor.
6. **Given** a turn whose usage could not be measured, **When** recorded, **Then** the usage is marked
   `unavailable`, not recorded as 0.
7. **Given** an attempt failing with class Auth/config or Refused, **When** processed, **Then** the task moves to
   WAITING for a human, with no new attempt and no rung escalation, even if budget remains.
8. **Given** an attempt times out for the second consecutive time at the same step, **When** processed, **Then**
   there is no third retry; the task waits for a human decision about scope or time.
9. **Given** an Invalid output result that is still wrong after one repair turn and one new-session turn, **When**
   processed, **Then** the core considers the next rung per the ladder; no further repair turns at the old rung.
10. **Given** repeated Infra/transient errors and only 1 agent turn left under the cap, **When** processed, **Then**
    the core stops at the agent turn cap even though the class's 3-retry limit is not exhausted, and every retry that
    ran counts toward the agent turn cap.
11. **Given** a task with exactly one agent turn left and the core has recorded a reservation for the launch effect,
    **When** the task is cancelled before the effect is dispatched, **Then** the reservation is released and that
    turn is not counted as used.
12. **Given** an agent launch effect with outcome `unknown` after a crash, **When** computing the remaining budget,
    **Then** that turn stays reserved and unavailable to other attempts until reconciliation confirms it ran (becomes
    used) or did not run (is released).
13. **Given** a coder ladder with three rungs, a reviewer ladder with two rungs using different models, and a task
    floor raised to the coder's third rung, **When** the reviewer runs, **Then** the reviewer rung is the rung mapped
    from the floor onto the reviewer's ladder, does not exceed the reviewer's last rung, and still passes the
    `denied`, approval and budget checks.

---

### User Story 5 - Explain state from recorded data (Priority: P3)

The project owner asks "where is this task, why did it stop, which rung did it use, how many turns are left". The
system answers entirely from recorded data, without calling an LLM, and every waiting task has a reason and a
condition for resuming.

**Why this priority**: Explainability is a committed product value, but it can be built after correct data exists.

**Independent Test**: With a store that has run the scenarios of Stories 2–4, query the explanation for each task and
compare it with the event log.

**Acceptance Scenarios**:

1. **Given** a task in WAITING, **When** the project owner asks for an explanation, **Then** the answer contains the
   wait reason, the condition for resuming, the exit paths and the remaining limits.
2. **Given** a task that has escalated rungs, **When** an explanation is requested, **Then** the answer lists each
   escalation with its failure signature and the event that triggered it.

---

### Edge Cases

- Configuration with duplicate keys, unsupported YAML tags, aliases nested beyond the limit, or a file exceeding the
  allowed size: reject with the error location, no partial reads.
- Self-referencing or cyclic dependencies: rejected at task creation.
- A role with no valid binding left after applying the allowlist: the task does not become READY and has a reason.
- Configuration becoming invalid between task creation and policy freeze: the task is in PENDING and does not
  silently use a different policy.
- Two competing answers to the same question: the first valid answer wins, the later one gets a conflict.
- Two signals arriving at the same time for the same task: order is decided by recording order, not by ID or the
  system clock.
- The system clock jumping backward or forward: the decision core does not read the clock; the current time is
  recorded input data.
- A result signal carrying an old attempt ID or one not matching the current attempt: ignored with a record, does not
  pass the step.
- The store cannot write (disk full, busy past the wait timeout): the signal is explicitly rejected; the system never
  reports saved when it has not actually saved.
- An effect outcome of `unknown`: must not be treated as "did not happen"; the task waits for reconciliation
  (FR-017).
- A task cancel request while effects with unknown outcomes remain: the task does not become CANCELLED until the
  effects are reconciled (FR-018).

## Requirements *(mandatory)*

### Functional Requirements

**Configuration and frozen policy**

- **FR-001**: The system MUST apply two separate merge rules (SPEC.md §8):
  - **Toolchain pack → project configuration:** the pack is preset data; the repo's `cusr.yaml` overrides the pack
    for keys under project authority (setup, gates, autofix, log digest, failure signature, CI rules, own pools,
    hotspots, conventions).
  - **Profile → override at task creation:** the profile defines which keys may be overridden; the override applies
    only to those keys and MUST NOT widen permissions beyond the caller's.

  Roles, model aliases, bindings, harnesses, workflows, profiles, shared pools and permissions come only from the user
  configuration; `cusr.yaml` declaring these keys MUST be reported as an error. Yolo permission never comes from
  `cusr.yaml`.
- **FR-002**: The system MUST reject configuration with duplicate keys, unsupported tags, invalid references or
  exceeding size/alias limits, and report each error with file, line and column.
- **FR-003**: The system MUST perform all six pre-execution checks of SPEC.md §8: references exist; outcomes are
  finite and have targets; every cycle has a non-resetting counter; the escalation ladder is reachable; every step
  has a valid initial binding; predicates belong only to the predefined set.
- **FR-004**: The system MUST produce a frozen policy containing the expanded workflow, per-step bindings and ladders,
  permissions, effective gates, limits, decision modes, schema version and the hash of the normalized effective
  configuration; semantically equivalent configurations MUST yield the same hash.
- **FR-005**: The frozen policy MUST be immutable per task revision. Changes happen only through an amendment with
  actor, reason, diff and a new version; v1 does not change the workflow graph of a running task.
- **FR-036**: An amendment MUST be accepted only when accompanied by a trusted permission context proving the actor
  has `admin` permission. This context is issued by the authenticated service layer; the core treats it as a
  mandatory precondition and MUST reject an amendment when the context is missing or there is only a self-declared
  actor name/`requested_by`. A rejected amendment MUST NOT change the task's policy, revision or budget.
  Authenticating the caller belongs to the daemon/CLI feature.
- **FR-037**: When a task starts executing, the system MUST create, in the same write, the frozen policy and the
  frozen execution context bound to the same task/revision and the same `base_sha`. The context contains the request
  content, acceptance, snapshots of attachment contents (with hashes), prompt/conventions and `base_sha`. In this
  feature, `base_sha` and attachment contents are provided by the caller as data; the core does not read git or the
  network.
- **FR-038**: The frozen execution context MUST be immutable: changes to the request or original attachments after
  freezing MUST NOT change its content or hash. Previous step output, diffs and Q&A are additional context with
  provenance and do not overwrite the original context. If either snapshot cannot be frozen, the task is in PENDING
  and neither snapshot is written.
- **FR-039**: This feature executes only decision mode `human`. The config validator MUST accept the syntax of
  `agent`, `agent_if_confident` and `agent_review` but clearly report them as not yet supported; when freezing the
  policy for a task using these modes, the system MUST refuse, keep the task in PENDING with a reason, and MUST NOT
  silently switch to `human`. "Not yet supported" is information about execution capability, not a configuration
  error: it does not cause the configuration to be rejected and does not block tasks using other valid workflows.
  Modes forbidden under FR-006 remain configuration errors.
- **FR-041**: The config validator MUST validate every declared workflow. When freezing the policy for a task using a
  workflow other than the default software development workflow, the system MUST refuse with error
  `unsupported_workflow`, keep the task in PENDING with a reason, and MUST NOT run the default workflow in its place.
  As with FR-039, an unsupported workflow is reported as execution-capability information, not a configuration error.
- **FR-006**: The system MUST reject automated decision mode (decider) for the decision types forbidden in
  SPEC.md §10: editing policy/ladders, increasing budget, handling secrets, deleting data and merging into a
  protected branch.

**Canonical task and state**

- **FR-007**: The system MUST normalize every task request into a single format with schema version and revision (the
  fields in SPEC.md §5.2), and dedup duplicate requests by source key.
- **FR-008**: A task MUST NOT reach READY without at least one acceptance criterion, when a dependency does not
  exist, is self-referencing or forms a cycle, or, for a task that requires confirmation, before it has been
  confirmed.
- **FR-009**: The system MUST allow only the state transitions of SPEC.md §6.1; every waiting state MUST have a reason
  from the predefined set and a condition for resuming or ending.
- **FR-010**: Terminal states (DONE, FAILED, CANCELLED) MUST NOT reopen; a retry after termination creates a new task
  with a source link and keeps the old task's history intact.
- **FR-011**: A request change after the task has run MUST be recorded immediately as source drift. The running
  attempt is allowed to finish, but the core MUST NOT start the next business step (new attempt, publish, merge) based
  on the old revision. The safe boundary is when no attempt is running and every related effect has a reconciliation
  outcome; there the task waits for the user to choose to continue the old revision, apply the new revision or create
  a new task. Cancelling the running attempt immediately is a separate operation and does not happen automatically
  because of source drift. Changing the revision MUST invalidate results and approvals that no longer apply, but does
  not reset the budget, the number of turns used or the history.

  While source drift is unresolved, business effects already in the outbox but not dispatched MUST NOT move to
  started; this condition is checked in the same write as the claim. Only attempt-stop and reconciliation effects can
  be claimed. When the user chooses to continue the old revision, these effects are claimed again normally. When they
  choose to apply the new revision or create a new task, they MUST be invalidated and the corresponding budget
  reservations released; choosing to create a new task sends the old task through the cancel process of FR-018.
- **FR-040**: When the user chooses to apply a new revision to a task that has run (same repo and workflow), the core
  MUST:
  - preserve the existing diff and checkpoints, without requiring a reset;
  - freeze a new execution context for the new revision (FR-037);
  - rerun Triage, then go through Code → Gates → Review → CI again before considering Merge; the Code step takes the
    existing diff as its starting point;
  - treat all gate results, review approves, CI and merge approvals tied to the old revision as no longer valid for
    the new revision;
  - keep the budget and turns used, the per-step model rung (only increases or holds) and the task deadline; if the
    remaining limits are not enough to get through the steps above, the task waits for a human decision.

**Decision core**

- **FR-012**: The decision core MUST be a function of (state, frozen policy, recorded signal) and MUST NOT read the
  clock, generate random numbers, call the network, read files or call an LLM. The current time, IDs and jitter MUST
  be supplied from outside as data.
- **FR-013**: The decision core MUST model the default software development workflow (Triage → Prepare → optional
  Scout → Code → Gates → Review → Publish → CI → Merge → Complete) at the decision level, returning effect requests
  instead of performing them.
- **FR-014**: The core MUST NOT pass a step merely because of a successful exit or the agent reporting "done": the
  result must be marked as schema-validated, match the current attempt, and every required gate must pass.
- **FR-015**: The core MUST NOT request a merge effect unless the conditions of SPEC.md §14.2 have been recorded as
  met for the exact head/base; checks in state pending, cancelled, missing or unknown do not count as met. The decider
  is never the party that decides a merge. The recorded evidence MUST include:
  - the expected set of required checks, with its source and a flag confirming the list is complete;
  - the result of each check in that set for the exact head SHA;
  - evidence that the head contains the base tip, tied to the exact head SHA and base SHA pair.

  If a required check is missing, the list has not been confirmed complete, or the head does not contain the base,
  the task waits and the core does not request merge.
- **FR-016**: Every effect request MUST have a stable idempotency key derived from the identity of the logical
  operation (namespaced by project/task/revision where appropriate); retrying the same operation reuses the same key,
  a new business attempt gets a new key.
- **FR-017**: The core MUST treat an effect outcome of `unknown` as unresolved: wait for reconciliation, do not replay
  dangerous operations on a guess. Reconciliation may be recorded as "performed successfully" only when it carries the
  full canonical result required by that effect type (for example the publish head SHA, the PR reference, a
  schema-validated agent result with usage); if required data is missing the effect stays `unknown`. A "performed but
  failed" reconciliation MUST carry a failure class so FR-019 can be applied.
- **FR-018**: In the same write that processes a cancel request, the system MUST:
  - block every new business effect of the task;
  - invalidate every business effect already in the outbox but not yet claimed for execution (not dispatched), so
    they are never executed afterwards;
  - keep effects that have started or have outcome `unknown` for reconciliation, not treating them as cancelled;
  - allow only effects that serve the cancellation: stopping the task's attempt and reconciling outcomes.

  After every started or `unknown` effect has been reconciled, the task MUST take a state reflecting the actual
  outcome: CANCELLED if the workflow had not reached the successful termination condition; DONE if reconciliation
  confirms the merge succeeded, with a record that the cancel request arrived too late. Cancellation does not undo a
  successful merge; reverting the change is a separate revert process.

**Escalation and budget**

- **FR-019**: The system MUST classify failures into the eight classes of SPEC.md §9.2, count only the Quality and
  Invalid output classes toward quality escalation, and MUST apply the correct handling for each class. Each class's
  own limit applies concurrently with the agent turn cap and the task deadline; whichever limit is hit first stops it.

  | Class | Required action | Own limit | Quality escalation |
  |---|---|---|---|
  | Rate limit | Cooldown until `reset_at` via a timer; if the reset is unknown, finite backoff | Per the declared backoff, with a maximum count and wait time | No |
  | Infra/transient | Retry at the same rung with backoff | At most 3 retries | No |
  | Auth/config | Wait for a human (WAITING), no automatic retry | 0 retries | No |
  | Timeout/stall | Retry once; if it still fails, wait for a human about scope/time | At most 1 retry | No |
  | Invalid output | One short repair turn, then at most one new-session turn; if still wrong, consider the next rung | 1 repair + 1 new session per rung | Yes |
  | Refused | Record the reason and wait for a human; no retry, no escalation to get past the refusal | 0 retries | No |
  | Quality | Compute the error signature; fix in bounded loops and the ladder of FR-020 | Per FR-020 | Yes |
  | Unknown | Wait for reconciliation; do not replay dangerous effects on a guess | 0 blind replays | No |
- **FR-020**: The system MUST apply the escalation ladder of SPEC.md §9.3: consider escalating after two consecutive
  failures with the same signature at the same rung; at most `quality_tries_per_rung` quality tries per rung (default 5, no hard cap); the rung per (task, step) only increases or holds;
  the task floor only increases. The task floor MUST be mapped separately onto each step/role's ladder (the same rung
  index in two roles does not mean the same model) and does not exceed that role's last rung. The rung chosen after
  applying the floor MUST still pass the `denied`, approval, escalation limit and budget checks.
- **FR-021**: An attempt MUST NOT start without sufficient budget. At a `needs_approval` rung, an attempt MUST NOT
  start without a valid approval bound to the exact task/revision, step, rung and policy hash; an `auto` rung does not
  wait for approval; a `denied` rung cannot be used even with an ordinary approval.
- **FR-022**: The budget MUST distinguish the **reserved** part from the **used** part:
  - The share allotted to an attempt MUST be recorded as reserved before the launch is requested, and counted as no
    longer available.
  - When it is confirmed the agent was actually called (including repair, resume, decider and rate-limited turns), the
    reservation becomes used and counts toward the agent turn cap.
  - When it is certain the agent did not run (for example the launch effect was invalidated before dispatch), the
    reservation MUST be released.
  - When it is unclear whether the agent ran (outcome `unknown`), the reservation MUST be kept until reconciliation
    completes; it is not released on a guess.
- **FR-023**: Running out of ladder, turns, budget or task deadline MUST move the task to wait for the user's
  decision; the system does not extend on its own.
- **FR-024**: Usage MUST carry the label `reported`, `estimated` or `unavailable`; never record 0 in place of missing
  data.

**State store**

- **FR-025**: Each signal MUST be accepted in a single atomic write comprising the duplicate check, event, derived
  state, effects and timers; the write contains no operations waiting on external I/O.
- **FR-026**: Duplicate signals (same dedup key, or same request ID with the same content) MUST NOT create additional
  logical effects; the same request ID with different content MUST be rejected as a conflict. "Content" includes the
  target task, the signal, the actor and preconditions such as the expected version; it does not include the time and
  IDs assigned during processing. The same key with a different target task is a conflict.
- **FR-027**: Event order MUST come from the committed recording order (increasing per task and with a global order),
  not inferred from IDs or the clock.
- **FR-028**: A command based on an old state version MUST be rejected as a conflict.
- **FR-029**: Derived state MUST be fully rebuildable from the event log, and the system MUST provide a way to compare
  the stored state with the rebuilt state.
- **FR-030**: Timers MUST be durable, with an ID, due time and payload; they are cancelled or consumed in the same
  write as the related signal and produce at most one logical signal.
- **FR-031**: Effects MUST have a recordable lifecycle (pending dispatch, started, succeeded, failed, unknown,
  invalidated) so later execution features can use the "record start → do I/O → record result" protocol. The move
  from "pending dispatch" to "started" MUST check, in the same write, that the effect has not been invalidated, so a
  cancelled effect cannot start because of a timing race.
- **FR-032**: The store MUST have only one writer at a time and reject a second writer.
- **FR-033**: When a write fails, the system MUST return a clear error and MUST NOT report the new state as saved.

**Explanation and evidence**

- **FR-034**: The system MUST answer task state explanations (position, wait reason, condition for resuming,
  rungs/bindings used, remaining limits, escalation history) solely from recorded data, without calling an LLM.
- **FR-035**: Each invariant I01–I12 within this feature's scope MUST have test evidence at the layer that actually
  verifies it (see the table below); invariants not yet in scope MUST be recorded as having no evidence and must not
  be reported as met.

### Evidence by invariant

| Invariant | Scope in this feature | Evidence layer |
|---|---|---|
| I01 Deterministic decisions | Full | Property tests on the decision core |
| I02 Single writer | At store level | Integration tests on a real store |
| I03 Atomic writes, effects after commit | The atomic write part | Integration tests with process interruption |
| I04 Idempotency keys | Key generation and duplicate blocking | Property + store integration; probes left to a later feature |
| I05 Separate, sequential worktrees | Out of scope | No evidence yet |
| I06 Evidence, not agent claims | At decision level | Property tests |
| I07 Everything is bounded | At decision level | Property tests |
| I08 Immutable per revision | Frozen policy and execution context, amendments | Property + store integration |
| I09 Roles, bindings, approvals, budget | At decision level | Property tests |
| I10 Event order, repeated triggers | Full | Property + store integration |
| I11 Merge conditions | At decision level | Property tests; execution left to a later feature |
| I12 Terminal states do not reopen | Full | Property + store integration |

### Key Entities *(include if feature involves data)*

- **Project**: allowed repo, base/protected branches, declared gate/setup configuration.
- **Task**: canonical request, revision, state, wait reason, dependencies, links to the frozen policy and the source
  task (on retry).
- **Frozen policy (FrozenPolicy)**: expanded workflow, per-step bindings and ladders, permissions, gates, limits,
  decision modes, hash; immutable per revision.
- **Frozen execution context (FrozenExecutionContext)**: request, acceptance, snapshots of attachment contents with
  hashes, prompt/conventions, `base_sha`; created in the same write as the frozen policy, same revision.
- **Permission context**: actor and permissions (`read`/`operate`/`admin`) authenticated by the service layer;
  precondition for amendments and administrative operations.
- **Step / Attempt**: a step in the workflow and one execution of that step with binding, rung, result, usage.
- **Domain event**: immutable, with schema version, task/revision, order, actor, cause, payload.
- **Signal (Trigger)**: input that makes the decision core run, with a dedup key.
- **Effect**: a durable I/O request with an idempotency key and a state lifecycle.
- **Timer**: a durable wake-up condition with a due time.
- **Question / Decision / Approval**: content, decider, scope of validity, revocation status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the configurations in the invalid sample set (covering each check in FR-002 and FR-003 at least
  once) are rejected with the correct file, line and column.
- **SC-002**: Validating a typical-size configuration (under 500 lines) returns a result in under 1 second.
- **SC-003**: At least 10,000 randomly generated signal sequences run through the decision core and the store without
  violating any in-scope invariant (evidence table), without exceeding turns, without using bindings outside the
  policy and without bypassing approvals; every failure found has a seed for reproduction.
- **SC-004**: Replaying the same signal sequence yields identical results in 100% of runs.
- **SC-005**: At least 200 process interruptions at random points during writes; after each, 100% of committed
  signals are kept, there are no half writes, and state rebuilt from the log matches 100%.
- **SC-006**: 100% of waiting tasks in every test scenario have a queryable reason, condition for resuming and exit
  paths.
- **SC-007**: Resending each signal 2 to 5 times does not change the number of events, effects or timers compared to
  sending it once.
- **SC-008**: The feature's acceptance report lists all 12 invariants, each marked "has evidence" with the test suite
  name, or "not yet in scope"; no invariant is left blank.

## Assumptions

- This feature has no daemon, socket or end-user CLI commands; capabilities are used through the programmatic
  interface and a signal simulator/replayer for testing. The CLI and daemon belong to later features.
- Results from agents, gates, review, CI and external effects are provided as pre-recorded signals; real schema
  validation of agent output and probing of external systems belong to the runner and recovery features.
- The decider (modes `agent`, `agent_if_confident`, `agent_review`: when to call it, when to accept, when to wait for
  a human, how to overturn a decision) is a separate feature with full acceptance scenarios.
- Only the default software development workflow is modeled; other workflows can be declared and validated, but
  freezing the policy for execution is refused with `unsupported_workflow` (FR-041).
- Task groups/epics, integration tasks, the scheduler with resource pools and the merge queue are recorded at the data
  level when needed for decisions, but actual scheduling belongs to a later feature.
- The environment is a single user on Linux/Ubuntu or WSL2 with data on a local Linux filesystem, as in
  SPEC.md §2.1.
- The technical stack follows the baseline of SPEC.md §17 and the constitution; this spec does not reselect
  technologies.
- The thresholds of 10,000 sequences and 200 interruptions come from Reliability Gates R4 and R1 of SPEC.md §18.1,
  applied at the core and store layers. Meeting these thresholds here does not mean meeting R1/R4 for v1, because R1
  requires killing a real daemon.
