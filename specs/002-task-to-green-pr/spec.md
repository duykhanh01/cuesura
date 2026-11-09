# Feature Specification: Execution flow from task to green PR

> Reflects the design at the time it was written; the code is the source of truth.

**Feature Branch**: No branch is created; the spec lives in `specs/002-task-to-green-pr`.

**Created**: 2026-10-27

**Status**: Draft

**Updated 2026-10-29**: The execution modes and confirmation before run add requirements M01–M08: `direct-pr`/`full-review`, confirmation of the harness/model/effort set before spawn, the worker prepares the PR content, commit before review, and preferring to resume the worker when fixing. The design is not implemented yet; the old spike/schema evidence is kept unchanged.

**Input**: User description: "Write the spec for feature 2 — option A: the whole flow to a green PR, including runner,
Claude/Codex, worktree, gate, review and GitHub."

## Context and scope

Feature 002 takes the milestone **End-to-end flow** of [SPEC.md §19](../../SPEC.md) as its main result, connecting the
[deterministic coordination core](../001-deterministic-core/spec.md) with real operations. The project owner assigns a
task with acceptance, confirms the run configuration, monitors the agent in its own worktree, receives a PR that has passed the gate, CI and review as per mode,
and knows clearly when the system needs their intervention.
The scope is intentionally broader than one roadmap line:
recovery, 200 daemon interruptions, inbox, CLI and health partly come from the milestone **Recovery and interaction**;
a real two-way vendor smoke test takes related evidence from R8. Keep them in feature 002 so that the execution flow is accepted as usable;
do not treat this as a small walking skeleton or as all of v1.

The scope includes the execution daemon, the standalone runner, the simulated harness and the two harnesses Claude Code/Codex CLI,
preparing worktree/context, setup/gate, the fix loop based on review/CI, commit/push/creating or reacquiring the PR,
a minimal CLI to assign tasks and handle questions, and recovery for the effects this feature executes.
Only the default software development workflow runs, with the `human` decision mode, and at most one execution task at a
time. An “execution task” is a task holding a slot for an attempt or for the Prepare/setup/gate/
autofix/publish step; it is not every task that has started but not yet ended. A task that is only waiting for CI, a person, a merge or a
cooldown releases its slot once the execution process/effect has a clear result. Read-only monitoring does not occupy this slot.
Coder, fixer and reviewer are the roles executed in this feature.

**Handover and completion:** A [green PR](../../GLOSSARY.md) is tied to one specific head SHA, with the gate/review and the list of required CI checks reconciled; it does not guarantee that the head is updated to the latest base. The task waits for the user to merge on GitHub, and is observed until the task ends or the observation window expires. A head change revokes green and waits for a person, without self-fixing or overwriting; a base tip change does not automatically trigger processing in this feature. When the PR is confirmed merged into the target branch, the system durably records the evidence and blocks new business work;
it moves to DONE only after the process belonging to the task has stopped and the sent effects have clear results (FR-040).
A merged head different from the verified head is marked `merged_head_unverified`, and does not certify the quality of the merged head;
**do not move to DONE just because the PR is green**. The system does not send merges and does not grant yolo permission.

Out of scope: executing merges and the merge queue, receiving tasks from GitHub issues/comments, Telegram, multi-channel notification sync,
a scheduler running multiple tasks in parallel, group/epic, decider, scout/refiner, arbitrary workflows,
full operational backup/restore/migration, dashboard, amend-policy, recheck/acceptance of a new head, and
`cusr task retry`. To redo a task, the user
uses `task add`; retry with a source link is for a later feature. Self-updating/rebasing the branch when the base changes belongs to the merge part, outside the scope of feature 002. Configuration that requires an unsupported capability must be blocked
before execution, not silently skip steps. This is one implementation milestone of v1, not the v1 release.

**Required delivery order within the same feature:**

0. Day-1 spike before building slice 1: the host sandbox and the nested sandboxes of the two harnesses, auth in a separate
   home, the schema of three roles × two vendors, the network and the GitHub head-at-merge fixture. This is a limited, isolated test with usage limits, not the end-to-end flow; it must pass before building runtime A.
1. Flow to green PR, fix loop and permissions/evidence with the simulated harness: US1, US2, US4 by their current story numbers
   (US4 was US5 in the previous version, before the priorities were reordered).
2. Recovery/duplicate prevention with all 200 interruptions and replays, inbox/cancel, CLI/health: current US3, US5, US6
   (US5 was US4 in the previous version). Prove runner reacquisition and no duplicate publish before the real smoke test.
3. Real smoke test with both vendor directions and both ecosystems, including restart and manual merge: SC-001,
   SC-002, SC-005, SC-008. Until the previous slice passes, the real end-to-end harness flow is not accepted or run.

Core 001 is now complete after the result of the merge effect requested by the system; blocking only the merge dispatch would leave the task stuck.
Feature 002 MUST add a decision path that accepts external merge evidence and completes at FR-040, with regression tests, without simulating approval or the success of a merge command that was never sent.
The decision and the rejected alternatives are recorded in
[ADR-0001](../../docs/adr/0001-observe-manual-merge.md).

**Environment settled:** The default automated flow is **Isolated**: rootless bwrap wraps the whole harness and the repo-controlled setup/gate/autofix, and the runner runs in a systemd user unit per
[ADR-0004](../../docs/adr/0004-isolated-bwrap-baseline.md). V1 has only one bwrap backend, behind a small `SandboxProvider` port; Native-only and Container/VM are not implemented. AppArmor 4, Ubuntu 24.04 and the Cuesura child stack are not required. A host with userns restrictions needs provisioning suitable for it by the administrator, per the [runbook](../../deploy/README.md), keeping the host policy/sysctl. The systemd user manager is a runner prerequisite, including checking that WSL2 actually has systemd enabled. By default, setup/gate/autofix/agent may use outbound Internet; there is no egress allowlist and no promise to block LAN/loopback, but filesystem/PID isolation and coordination credentials remain in place. Slice 0 checks this configuration before rollout.
Slice 0 still tests with internal sandboxing enabled; this is not the Native-only mode. If nesting fails, allow only the `external_verified` mode under the conditional exception of ADR-0004, after the outer boundary and permission/approval have been verified and the owner has explicitly allowed it; no `--dangerously-*` flag or permission bypass.

## Clarifications

### Session 2026-11-08 — slot reservation and lending while waiting externally (issue 206), replacing the rest of Q3

- A task that leaves RUNNING to wait for CI, a merge, a person or a cooldown turns its slot into a reservation and does not release it. If the wait is due to
  a pause, a deadline, a cancel or cleanup after a merge, the slot is still released as before.
- A reserved slot can be lent: a READY task that has never run, does not depend on the reserving task and does not work on its PR, may run on the borrowed slot. Each reserved slot lends to one borrowing task at a time, and the number of borrowing tasks does not exceed `runtime.concurrency`, so the number of tasks running at once does not exceed 2N. A task that has already started does not borrow, and a borrowing task does not hold a reservation or lend further; if it waits externally, it returns the borrowed slot.
- When the reserving task returns, it runs immediately on its own slot, without queuing and without interrupting the borrowing task. The borrowing task finishes what it is doing; when it reaches the next step that needs a slot (Prepare/setup, agent, gate, publish), it returns the borrowed slot and waits in WAITING/policy `execution_slot`, like a started task.
- A reserving task reacquires its slot only when it runs work that needs a slot. Read-only or GitHub read/write work (polling CI, creating a PR, marking ready) does not reacquire the slot, does not reset the deadline and does not end the borrowed slot. A borrowed slot is tied to the specific reservation cycle it was lent in: if the reserving task has reacquired its slot and then reserves again, the old borrowed slot still ends.
- A reservation expires after `runtime.slot_reservation_hours` (default 24), counted from when the reservation began. On expiry, the slot becomes a free slot, allocated under FR-044.03; a task that lost its reservation and returns must queue by priority. A task borrowing that slot also returns it at the next step that needs a slot, as above.

### Session 2026-11-07 — per-task slot (issue 206), replacing part of Q3

- The slot is tied to the task, not to the step type. A RUNNING task holds its slot across every step and automatic effect, including effects that do not run a process (creating a PR, review, fix_review…); it does not release it at step boundaries. Previously the slot was released between `publish → pr → review`, and the task had to queue again behind lower-priority tasks (issue 203).
- The number of tasks holding a slot at once is `runtime.concurrency` in the user config, default 1, read when cusrd starts. The allocation order still follows FR-044.03.
- The rest of Q3 stays unchanged in this milestone: a task that leaves RUNNING to wait for CI/merge/a person/a cooldown still releases its slot. Reservation and lending while waiting externally is the next step of issue 206.

### Session 2026-11-02 — replacing Q5/Q12 and the subset rule of FR-042

- Required checks are the union of the snapshot and every GitHub check name currently required, including checks outside the policy/pinned app, applying whether yolo is on or off. The names/app are stored in the CI evidence; the snapshot is kept unchanged.
- With no required checks, the observation still moves to waiting for merge; only yolo does not merge, and the log instructs the user to declare `ci.required_checks`, without falling back to every check on the head.
- The merge check verifies by itself that the correct pinned app is used and compares `head...target` for `ahead_by === 0`; the old schema/event/wait mismatch replay is kept. Current details are in FR-042 and SPEC.md §14.2.

### Session 2026-10-27

- Q: Does feature 2 cover the whole flow to a green PR, or only the runner/harness? → A: The whole flow to a green PR
  (option A), per the next milestone in SPEC.md §19.
- Q1: How does waiting for a merge end? → A: Track the PR; a manual merge that is confirmed becomes DONE with its
  merge commit; a head different from the verified head follows Q9. No merge is sent and no approval is simulated (FR-040).
- Q2: Is a green PR a snapshot or is it tracked? → A: The evidence is tied to one head SHA and is observed until
  the task ends or the observation window expires per Q11; a head change revokes green and waits for a person; a PR closed without merge waits; a base tip change is not
  handled automatically in feature 002 (FR-041/043, glossary).
- Q3: Is the slot held while waiting? → A: No; the slot is only for work being executed, while the worktree is still kept. A task that needs further fixes must queue to request a slot (FR-044, glossary). Replaced by the Sessions of 2026-11-07 and 2026-11-08: per-task slot, reservation and lending while waiting externally.
- Q4: Where is the configuration checked? → A: Fix the base revision, check, and freeze the snapshot before
  READY → RUNNING; on error, PENDING with diagnostics, no worktree yet. The order is snapshot → RUNNING →
  create worktree (FR-002).
- Q5: What is the source of the required checks? → A: `ci.required_checks` is frozen in `cusr.yaml` and reconciled with GitHub branch protection/rulesets; the GitHub requirements must fall entirely within the snapshot per Q12,
  otherwise wait for a person, without taking a union or replacing the snapshot. If it cannot be read, it is unknown and not treated as a match (FR-042).
- Q6: Keep or split the feature? → A: Keep one feature combining two milestones: deliver the fake-harness version first, then recovery/interaction,
  and the real smoke test last, in the order above.
- Q7: Replay projection? → A: After each interruption it must be rebuilt from the event log and match 100% (SC-004).
- Q8: Is there a `task retry`? → A: Deliberately out of scope; use `task add` to assign again. Retry with a source link belongs to a later feature (FR-045).
- Q9: If a PR is merged at a head different from the verified head, how does the task end? → A: DONE with
  `merged_head_unverified`; the evidence records the merged head, the head Cuesura verified, and a statement that the quality of the merged head is not certified. DONE confirms the merge per S01 (FR-040).
- Q10: Accept a waiting state where only a manual merge or cancel remains? → A: Yes for feature 002;
  FR-029 lists the exits for each detail, and the CLI explain prints exactly those exits. Recheck of a new head and amend-policy belong to a later feature, and no extra rounds or deadlines are opened.
- Q11: Does tracking a PR until terminal violate I07? → A: Use backoff up to a cap and a finite total observation window; on expiry, move to WAITING/policy with `observation_expired` and stop automatic polling. Only recheck reconciles again; if merged, it stays DONE; the plan fixes the concrete values (FR-043/046). Updated per issue 248: when the window expires while the PR is still open on the task's exact head, a new window is extended automatically
  (each window remains finite, and polling at the 1-hour cap does not call the agent or hold a slot), without stopping to wait for a person.
- Q12: How is a repo without branch protection handled? → A: If the GitHub requirements are a subset of the snapshot, reconciliation passes; if there is a check outside the snapshot, `required_checks_mismatch`. If GitHub confirms there are no rules, record `github_required: none`; if it cannot be read, it stays unknown. Amends the details of Q5 (FR-042).
- Q13: With the same priority, does an unfinished task take precedence over a new one? → A: Yes; WAITING/policy with `execution_slot` comes before READY. Within the same group, order is by the time of the slot request, not the time the task was created; a running task is not interrupted (FR-044).
- Q14: When is a PENDING task caused by configuration retried? → A: Only when the task is confirmed or rechecked with dedup, re-reading the latest base; the base is not tracked automatically. Keep needs_info and add the detail `config_invalid` / `capability_missing` (FR-002/046).
- Q15: If a merge is seen while an attempt/effect is still running, how is it handled? → A: Durably record the merge and block new business effects, using the stop/reconcile mechanism of cancel without creating a fake cancel request. DONE only when the process has stopped and the sent effects have clear results; a push that was already sent may still have succeeded and must be recorded as it actually happened. Keep the unpublished local diff/commit in the worktree, without sending a new push; restart continues the stop/reconcile work. When the reconciliation limit is reached, wait in merge_cleanup_pending, with a finite recheck (FR-040/046).
- Q16: Does DONE with merged_head_unverified release dependencies? → A: Yes, but only after DONE is recorded per Q15. The dependency condition is completion, not quality certification; a dependent task still goes through its own checks, and explain shows the uncertified prerequisite and links to the evidence (FR-001/027).
- Q17: Does the slot waiting time count toward the deadline? → A: Yes, from the first run of the workflow, per SPEC.md §9.4; a first wait for a slot while READY is not counted, while waiting to re-request a slot after it has run is counted. Explain separates the slot waiting time; Q13 only prioritizes unfinished work at the same priority and does not guarantee protection against slot starvation (FR-043/044).
- Q18: Is an ADR recorded for observing manual merges and uncertified DONE? → A: Yes, at [ADR-0001](../../docs/adr/0001-observe-manual-merge.md): one section covering context, decision, reasons and rejected alternatives; self-merge is postponed to a later feature, and cancel-only does not accurately reflect the merge result.

### Session 2026-10-28

- Q19: What is the default network for setup/gate/autofix and the agent? → A: Allow outbound Internet to use registries/vendors; keep filesystem isolation and do not grant coordination credentials. Feature 002 has no domain allowlist or commitment to block LAN/loopback; the snapshot records the network mode explicitly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Assign a task and receive a PR with enough evidence to approve (Priority: P1)

The project owner assigns a task to an allowed repo. The system fixes the request and configuration, creates a separate environment, calls the coder, runs the gate, calls the reviewer, then publishes the PR and tracks CI. The user can see the PR, its status, the reasons for waiting and the evidence, without coordinating each step themselves.

**Why this priority**: This is the first usable result of the product, connecting the existing core with real work.

**Independent Test**: Assign a small task on a sandbox repo with a gate and required checks configured;
check the evidence at each step, the single PR and the waiting-for-merge status. This flow can be tested with the simulated harness before running the smoke test with the real harness.

**Acceptance Scenarios**:

1. **Given** a valid task with sufficient permission and budget, **When** the task is assigned and every step passes, **Then** the system
   creates exactly one worktree/branch for the task, runs Code → Gates → Review → Publish → CI, and shows the green PR
   with its head SHA; the task waits for merge approval, is not DONE, and there is no merge request.
2. **Given** the task lacks acceptance, is not yet confirmed, or has a dependency that is not DONE, **When** the task is received,
   **Then** the task is PENDING with the reason and how to resolve it; no worktree is created and no agent is called.
3. **Given** the project configuration is invalid, **When** the base/configuration is rechecked before READY → RUNNING,
   **Then** the task stays in or returns to PENDING/needs_info with config_invalid, and no worktree is created.
   If an execution-capability error is detected after the task is already RUNNING, the task moves to WAITING/policy, not back to PENDING. An agent editing the configuration after the snapshot is frozen does not change the gate of that task.
4. **Given** a task creation request is sent again with the same request ID and content, **When** the daemon processes it,
   **Then** it returns the same task; the same ID with different content returns a conflict and does not create a second task.
5. **Given** the profile requires scout, decider or an unsupported workflow, **When** it is checked before moving to RUNNING, **Then** the task is PENDING/needs_info with capability_missing and how to fix the input/profile; the workflow/role is not swapped automatically. If it is only detected after RUNNING, WAITING/policy applies per scenario 3.
6. **Given** the user has merged the PR (head matches or differs from the verified head), **When** a poll, recovery or recheck confirms
   the repo/PR/target branch, the merged head and the merge commit, **Then** record the evidence immediately, complete the stop/reconcile per FR-040 before writing DONE exactly once and releasing the dependency;
   there is no merge request from Cuesura. Repeated results do not produce a second completion. A merge at a different head still ends as DONE with merged_head_unverified, recording both heads and the statement that the quality of the merged head is not certified; if evidence is missing, wait for reconciliation and do not mark DONE automatically.
7. **Given** task A is only waiting for CI/merge and has already released its slot, **When** task B starts executing and then A's CI fails,
   **Then** A waits in policy with the execution_slot detail and does not take B's slot; after B releases its slot, A is considered by priority, then tasks already started before READY at the same priority, then the time of the slot request within the same group. A READY task with higher priority still comes before A; no two tasks execute at the same time.
8. **Given** a task is PENDING/needs_info because of config_invalid or capability_missing and the base has been fixed,
   **When** there is no user command yet, **Then** it is not retried automatically; only when the task is confirmed or rechecked does it read the latest base and recheck/freeze the snapshot per FR-002. A duplicate request does not freeze or assign work twice; if the configuration still has errors, it stays PENDING with the matching detail, with no worktree or agent.
9. **Given** the fixer or push effect of the task is still running when the PR is merged, **When** the system confirms the
   merge, **Then** durably record the evidence, block new business effects, invalidate effects not yet dispatched, stop the processes belonging to the task, and reconcile the sent effects; do not mark DONE or release the slot while the work is still unclear. A push that was sent may succeed after the merge and is recorded; publish is not retried. The remaining local diff/commit is kept with the evidence, and no new push is sent. DONE only after stop/reconcile completes.
10. **Given** B depends on A and A's merge has been confirmed but not certified, **When** A is still stopping/reconciling, **Then** B keeps waiting on the dependency; after A records DONE with merged_head_unverified, the dependency condition is met. B becomes READY/runs only when its own conditions are met; B's explain shows that A is uncertified and links to A's merge evidence, and does not require additional approval just because of this flag.
11. **Given** a new task is waiting for a slot in READY and an already-run task is re-requesting a slot, **When** time passes,
    **Then** only the already-run task consumes its whole-task deadline; when it expires, task_deadline applies and no new business work may be assigned. Explain separates the slot waiting time; a restart does not reset the deadline or lose recorded waiting time, and the Q13 priority must not be described as guaranteeing protection against slot starvation.

---
### User Story 2 - Fix within limits based on gate, review and CI (Priority: P1)

The project owner receives changes that have been checked. When a check fails, the agent receives the exact error and fixes it within the permitted limits; the system does not treat the agent's report of completion as sufficient, and does not reuse old results for new code.

**Why this priority**: A PR is only useful when it has quality evidence, and the fix loop does not consume resources without limit.

**Independent Test**: Use sample tasks that in turn cause a gate failure, a review request_changes and a code-caused CI failure; check the fix loop, the new evidence and the number of rounds. Separate infrastructure-error samples to verify that the model is not escalated.

**Acceptance Scenarios**:

1. **Given** the coder returns a valid result but the gate fails, **When** the result is processed, **Then** nothing is published;
   the fixer receives the bounded error log and the acceptance criteria; after fixing, the gate must run again before review.
2. **Given** the reviewer requests changes, **When** the fixer changes the code, **Then** the old review result becomes invalid;
   the gate, checkpoint commit and review run again before publish in `full-review`. The reviewer uses its own session, is read-only, and may use the same vendor/model; if the binding or quota is missing, it waits or asks for confirmation of another choice.
3. **Given** the PR has a code-caused CI failure, **When** fix rounds remain, **Then** fix it in the task's worktree, rerun the necessary gate/review, and update that same PR; CI on the old head does not make the new head green.
4. **Given** CI has an infrastructure or flaky error with classification evidence, **When** policy allows a retry, **Then** retry only within the limit, and do not escalate the model because of this error. An unclassified error makes the task wait with a reason, and it is not automatically treated as a code error.
5. **Given** the rounds, deadline or budget are used up, or approval for the next rung is missing, **When** an agent call is needed, **Then** do not start an attempt; the task waits for a decision and shows the limit reached and how to finish.
6. **Given** GitHub requires A/B and the frozen CI rules require B/C, **When** determining whether the PR is green,
   **Then** wait for the union A/B/C on the exact head; if all three succeed and the gate/review are valid, it is green, and the snapshot is not edited.
   Record the names and apps of the GitHub requirements in the evidence. If GitHub cannot be fully read, the status is unknown and waits for infra.
   If GitHub only requires B, or confirms there are no rules, B/C must still pass.

7. **Given** the PR is green and waiting for merge, **When** the head or the set of required checks changes,
   **Then** a head pushed by someone outside revokes green and waits on policy for a person's decision, without self-fixing or overwriting the remote; a GitHub-required check not covered by the snapshot revokes green and waits on policy. If only the base tip changes, keep the evidence for that head, record the observed information, and do not update the base automatically, call the fixer, rerun checks, or change state just because the base tip changed. Do not claim merge eligibility.
8. **Given** the PR is green, **When** a check is rerun or the PR is closed without a merge,
   **Then** a pending/failed check revokes green and goes through CI/the fix loop; if the PR is closed, it waits on policy with the pr_closed detail, not DONE, and no other PR is created; it is still observed within the FR-043 window. If the PR reopens while the window remains, reconcile the exact head/check set again before continuing within the execution limits; after expiry, a recheck is required.
9. **Given** CI has not passed within the wait time or the number of automatic CI checks granted,
   **When** the limit is reached, **Then** the task is WAITING/ci with ci_wait_exhausted, and it does not self-fix, rerun or extend. Observation of the PR status continues within the FR-043 window, without holding a slot or calling an agent. A late CI pass on the exact verified head, with all required checks, moves the task to waiting for merge (under yolo, the merge follows) without reopening the execution budget; other results are only recorded as evidence. A confirmed merge is still DONE per FR-040, even at a head different from the verified one.
10. **Given** the task is waiting for a person to merge, **When** the execution deadline expires, **Then** WAITING/policy with task_deadline, and no new attempt is opened; the PR is still observed automatically within the FR-043 window. A merge afterward makes it DONE per FR-040 once confirmed; after the observation window expires, a recheck is required, and the deadline is not extended.
11. **Given** the PR is not yet terminal, the last observation shows the PR closed, a head different from the task's, or unknown, and automatic observation has reached its total expiry (if the PR is still open on the exact head, the window extends automatically per FR-043.04), **When** the deadline is reached, including across a restart,
    **Then** WAITING/policy with observation_expired, and automatic polling stops; earlier backoff does not exceed the cap. A recheck reconciles once: if a merge is seen, DONE per FR-040; if not merged or unknown, polling still stops, keeping the reason/limit currently blocking and the new evidence; observation/execution is not extended.

---

### User Story 3 - Continue safely after the daemon is stopped (Priority: P1)

The project owner can restart the daemon without losing work, without calling an extra agent for the same attempt, and without creating a duplicate PR. When it is unknown whether an operation has happened, the system says so clearly and reconciles before continuing.

**Why this priority**: Not repeating operations and not losing data are preconditions for any real execution.

**Independent Test**: Interrupt the daemon before and after launching the agent, committing, pushing and creating the PR;
restart it, then compare processes, history, worktrees, remote branches and PRs with a run that was not interrupted.

**Acceptance Scenarios**:

1. **Given** the agent is still running when the daemon dies, even if its process identity was not recorded yet,
   **When** the daemon restarts, **Then** it reacquires that attempt before assigning new work; no second runner/harness is created, and the budget reservation is not released while it is unclear whether the attempt ran.
2. **Given** the agent finished while the daemon was not running, **When** recovery happens, **Then** the valid result and the unprocessed output are recorded once, logically; the agent is not run again just to obtain the result.
3. **Given** a commit, push or PR creation succeeded but its confirmation was not saved, **When** recovery happens,
   **Then** reconcile to reacquire the exact result; do not create duplicate commits/PRs, do not force-push, and do not reset the worktree because HEAD differs from the checkpoint.
4. **Given** the process identity does not match or the remote reconciliation fails due to a network error, **When** recovery happens,
   **Then** keep the status unclear and wait for handling; do not kill processes that do not belong to the task, and do not replay dangerous operations. An attempt proven dead but missing its result is recorded as lost.
5. **Given** the state store cannot be written to, or another daemon holds write rights, **When** assigning work, **Then** do not emit new effects; report a health error and do not claim the state has been saved.
6. **Given** state is restored after each daemon interruption, **When** the projection is rebuilt from the committed event log, **Then** the projection matches the saved state 100%, including slots, ingest results and timers; no work is assigned while differences remain or a claim has not finished reconciling.
7. **Given** merge evidence is durably recorded but stopping/reconciling is not finished, **When** the daemon restarts or a late fixer/push result arrives, **Then** continue stopping/reconciling within the remaining limit; do not resume the fixer, republish, or release the dependency early. If the limit is reached while still unknown, WAITING/policy with merge_cleanup_pending and the unclear parts; a recheck performs one finite pass, and DONE is recorded only after there is enough evidence of the process stop and the results of the effects.

---

### User Story 4 - Run agents with the correct permissions and readable evidence (Priority: P1)

The project owner knows which agent ran, with which permissions and model, what changes it made, and how many rounds it consumed. The reviewer may not edit the repo; logs and context must not expose coordination secrets.

**Why this priority**: Real execution is only allowed when permissions and results can be verified.

**Independent Test**: Run the same set of coder/fixer/reviewer scenarios with each harness, including valid output, malformed or truncated output, refusal, missing usage, writes outside scope, and a run that is silent but still making progress.

**Acceptance Scenarios**:

1. **Given** both harnesses have verified the required capabilities, **When** each supported role is run, **Then** the result is normalized and tagged with the provenance of the exact attempt; the history includes harness/model/version, permissions, time, usage and artifacts. Missing usage is recorded as unavailable, not replaced with 0.
2. **Given** the exit is successful but the output has the wrong structure, is truncated, has the wrong semantics, or contains only an old artifact, **When** the result is received, **Then** it is not treated as done/approved; the policy's limit for handling invalid output applies.
3. **Given** the reviewer is read-only or the coder's write area is restricted, **When** launched, **Then** the effective permissions match the policy; if a change outside the allowed area is detected, stop and reconcile.
   An environment that cannot prove the required restriction is blocked before the related automatic execution.
4. **Given** the agent does not emit logs but its child processes are still working, **When** stall is checked, **Then** silence is not treated as lost progress; when a timeout/stall has truly occurred, stop exactly that process tree within a finite time, and do not kill shared processes outside the task.
5. **Given** the context/log contains test secrets or exceeds the size limit, **When** it is collected and displayed, **Then** secrets are masked before being stored or exported, and any truncated part is clearly reported; output not yet ingested is not silently dropped, and the context does not lack required acceptance criteria while being sent as complete.
6. **Given** the profile requires permissions or a hard cost cap that the harness has no evidence of supporting, **When** checked before the run, **Then** block the attempt and state the missing capability; do not replace the commitment with a cost estimate or with the fact that a separate worktree exists.

---

### User Story 5 - Answer questions and cancel work in a controlled way (Priority: P2)

The user sees questions in the inbox, answers them so the agent can continue, or requests a cancel while keeping the changes already made. An agent does not need to stay alive just to wait for an answer, CI or quota.

**Why this priority**: The real flow must have a way to handle missing information or inability to continue.

**Independent Test**: Have the harness return needs_input, send the answer twice, then try to cancel an attempt that has child processes and a task whose publish result is unclear.

**Acceptance Scenarios**:

1. **Given** the agent asks the user a question, **When** the attempt ends, **Then** the question is saved and shown in the inbox, the task waits for human_input, and no agent is running just to wait; a restart does not lose the question.
2. **Given** the question belongs to the current revision, **When** an authorized person answers, **Then** the first valid answer is recorded and included in the context of the continuation; a repeated request returns the old result, and a competing answer or one for the wrong revision is rejected, without creating another attempt.
3. **Given** the task has a running attempt and effects not yet dispatched, **When** it is cancelled, **Then** block new business effects, stop the attempt's process tree within limits, and preserve the diff; CANCELLED is recorded only when the operations already sent have clear results.
4. **Given** a cancel happens while the publish result is unclear, **When** reconciliation finds that the PR was created, **Then** record the PR and the actual result before completing the cancel; do not close the PR, delete the branch, or pretend nothing was published.
5. **Given** the agent hits its quota limit or is denied permission/auth, **When** handled, **Then** the task waits with a reason; a cooldown has a finite recheck schedule, an auth error waits for a person, and a refusal is not retried or escalated to get past it.
6. **Given** the user requests cancellation of a task that has a PR, **When** reconciliation confirms that the PR was merged into the target branch before the cancel completes, **Then** complete stop/reconciliation, then record DONE with the merge commit and “cancel request arrived too late”,
   not CANCELLED; a head different from the verified one records merged_head_unverified per FR-040. If the merge result cannot be read, keep waiting for reconciliation; do not infer that it was not merged.
7. **Given** the agent returns needs_context/blocked, or the old session is no longer usable when the answer arrives, **When** deciding whether to continue, **Then** record the missing parts and the handling path; call a new attempt only with complete Q&A and only when permission, slot and budget are sufficient; do not call a role outside the scope automatically.

---

### User Story 6 - View and control the flow through the CLI (Priority: P2)

The project owner or the assistant, once granted permission, uses the CLI to create, view, explain and cancel tasks, answer questions and approve escalation rungs. Normal status is built from recorded data and does not require calling an LLM.

**Why this priority**: The end-to-end flow must be usable and testable without directly editing the state store.

**Independent Test**: Run the operations in human-readable and machine-readable form, including a lost daemon connection, repeated requests, missing permissions, nonexistent objects and an old version.

**Acceptance Scenarios**:

1. **Given** the task is running or waiting, **When** the task is viewed or explained, **Then** the current step, the reason, the PR/head if any, the rounds used or reservations held, the evidence and the next action are shown; no new LLM call is made.
   Slot waiting time is shown separately; an uncertified DONE prerequisite is shown with its link to evidence, including after the dependent task has started. A confirmed merge that is still stopping/reconciling is shown separately from DONE, with the unclear process/effects and how to handle them.
2. **Given** a finite command in machine-readable mode, **When** it succeeds or a handled error occurs, **Then** there is exactly one versioned result, a stable error code and an exit code per SPEC.md §15.1; logs are not mixed into the result. Continuous log viewing has a resume position, so that confirmed records are neither lost nor duplicated.
3. **Given** the caller has only read permission or self-declares the project owner's name, **When** it sends a change/approve operation, **Then** the service rejects it; the agent cannot approve its own escalation or obtain admin secrets through the CLI.
4. **Given** a request to approve a merge/yolo, **When** sent to this version, **Then** report that it is not supported, do not record merge permission, and do not dispatch a merge; guide the project owner to merge on GitHub, then observe or recheck to record DONE.
5. **Given** the user wants to redo a terminal task, **When** task retry is called, **Then** the CLI reports that the feature is not supported and does not create a task; it guides the user to use task add. Task add creates an independent request through triage/confirmation/policy, and does not reopen the old task or add a retry link automatically.
6. **Given** the task is being observed, **When** an authorized person calls task recheck, **Then** perform one PR/CI reconciliation with a timeout, save the evidence and update the status; do not send a merge, call an agent, or reset the budget/deadline. Repeated requests are deduplicated; no additional parallel observation chain is created.
   After observation_expired, only this one reconciliation is done, and polling is not restarted; a PENDING task with a configuration/capability error reads the latest base and tries to freeze the snapshot per FR-002. A terminal task is not reopened.
   If a merge has been confirmed but merge_cleanup_pending remains, recheck requests one finite stop/reconciliation pass per FR-040, and does not continue the workflow or retry publish.
7. **Given** the task is waiting with each detail in FR-029, **When** task explain is called, **Then** it prints exactly the exits still available and the limits already reached; it does not suggest amend-policy, a recheck of a new head, or opening additional rounds.

### Edge Cases

- **EC-001**: A second task becomes eligible while the execution slot is held: it waits for assignment; restart restores the slot first. A task that has not run stays READY; a task that has run and needs further fixes goes to WAITING/policy with execution_slot.
  A task that only waits for a person/CI/merge/cooldown holds no slot; an effect/process whose result is unclear still holds its claim.
  A first wait for a slot while READY does not count toward the deadline; waiting to re-request a slot after the workflow has run does count.
- **EC-002**: The worktree/branch already exists, is missing, or has unpreserved changes: reconcile ownership/checkpoint; recover only when there is enough evidence, and do not overwrite or delete it to retry.
- **EC-003**: Setup/gate/autofix has side effects and the daemon dies before saving the result: re-run only if the contract allows it; otherwise wait for a person, with the work already done preserved.
- **EC-004**: Output is cut mid-record, log rotation, disk full, or the temporary store is busy: do not lose the mark of confirmed ingest, and do not treat a result that is not durably recorded as a success.
- **EC-005**: Reboot, machine sleep, clock change and PID reuse: do not extend the deadline, mistake one process for another, or logically consume a timer twice.
- **EC-006**: A required check that is missing, pending, cancelled or unknown, or a list that cannot be fully retrieved: do not report the PR as green.
  GitHub requirements outside the snapshot wait for a person; a snapshot with extra checks is still valid and all of them must pass.
  When GitHub confirms there are no rules, record `github_required: none`, which is different from unknown.
  A head change makes the old CI/review invalid for the new head;
  a base tip change alone does not revoke the head-based evidence and does not trigger a base update or merge.
- **EC-007**: The remote branch was updated by someone else, or the PR matches a duplicate marker: revoke green, reconcile, and wait when ambiguous; do not create a replacement PR or overwrite the remote. A PR closed without merge waits on policy; a PR merged into the target branch becomes DONE after stop/reconciliation completes per FR-040, including when a cancel is being processed; a head different from the verified head records merged_head_unverified and does not certify the quality of the merged head. The merge commit may differ from the head that was merged because of squash/rebase; evidence of the PR head at merge time is needed, and these two commits must not be treated as equal.
- **EC-008**: A terminal task does not reopen itself because a remote event arrives later. A merge that actually happens after CANCELLED has been durably recorded is an external action outside the task lifecycle; the reconciliation history records the fact but does not change the terminal state. This differs from a merge that happened while the cancel request was still being processed.
- **EC-009**: Source drift is recorded during a run: let the current attempt finish, block the next business step, keep the diff, and wait for a decision at a safe boundary; do not use evidence from an old revision for a new revision.
- **EC-010**: A merge occurs while fixer/setup/gate/publish is still running: recording the merge does not mean the process has stopped or that a sent push has been revoked. Keep the claim while it is unclear, save late results as well as the unpublished diff/commit locally; do not push the remainder automatically, delete the worktree, or drop the merge evidence after a restart.
## Requirements *(mandatory)*

### Functional Requirements

The original FR codes stay stable for group references. For a group that has been split, each sub-code (for example `FR-040.01`)
is a separate acceptance obligation; plans/tasks and verification reports must use the sub-codes. A reference to a group
code covers all of its sub-items and does not replace verifying each item.

**Task intake and execution preparation**

- **FR-001**: Receive the task and its dependencies. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-001.01** | Intake MUST check acceptance, dependencies, permissions, workflow/profile and request dedup before running, per feature 001; a person with the right may assign, confirm and read the task result in the repo. |
  | **FR-001.02** | A dependency MUST be treated as satisfied when the prerequisite is recorded DONE, including merged_head_unverified; this flag adds no approval requirement. The dependent task still goes through its own conditions. |
  | **FR-001.03** | A dependency MUST NOT be released just because a merge is seen while the prerequisite is still stopped or being reconciled; unconfirmed evidence is shown per FR-027.04. |
  | **FR-001.04** | A prerequisite recorded FAILED or CANCELLED MUST cancel the dependent tasks waiting on it, instead of leaving them PENDING indefinitely. The cancel reason is `dependency_failed:root=<root task> via=<prerequisite> (<status>)`; the cancellation cascades down the chain, carrying the root task to each dependent task (issue 249). |

- **FR-002**: Check configuration and fix the snapshot. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-002.01** | The system MUST obtain the actual base revision, check configuration/capability, and fix the policy/context together when handling the start signal, in the order snapshot → RUNNING → create worktree. |
  | **FR-002.02** | A configuration/capability error before RUNNING MUST keep or return the task to PENDING/needs_info with config_invalid/capability_missing respectively, together with diagnostics and how to fix it; no worktree is created. |
  | **FR-002.03** | After this error, the system MUST retry through a deduplicated confirm/recheck, read the latest base, and check/fix the snapshot; it still goes through acceptance/dependency/permission checks. For environment-caused errors (capability_missing, or config_invalid containing only the `stacked_base` check), the daemon MUST automatically re-run a read-only preflight on a per-task backoff (5 minutes, doubling, up to 1 hour; reset when the task changes version), and records `config_checked` only when the result differs from the previous one. Real configuration errors still wait for a person to fix them, then confirm/recheck (issue 249). |
  | **FR-002.04** | A policy/capability error detected after RUNNING MUST move the task to WAITING/policy, not back to PENDING; infrastructure errors follow FR-015. |
  | **FR-002.05** | The system MUST NOT drop a role/step or change a binding to get past a configuration/capability check. |
  | **FR-002.06** | A base branch that differs from the repo's default branch but is the head of an open (unmerged) PR MUST be blocked by preflight as config_invalid with the `stacked_base` check. The error names that PR, the owning task if the branch is `cusr/<task-id>-…`, and the ways out: merge that PR first, continue the work as a PR with `task add --pr` (adopt), or recreate the task on the PR's base. Only the owner may choose an intentional stack, by the label `stacked-base` on a task the owner created; the label on a task created by the assistant has no effect (issue 167). |

- **FR-003**: Each execution task MUST have one worktree and one branch owned by the orchestrator. The system MUST check
  the repo/cwd/write area and ownership before use, and preserve the original repo, uncommitted diffs and unpushed commits.
  A worktree that exists or is missing MUST be reconciled before it is reclaimed or recovered.
- **FR-004**: Setup, gate and autofix MUST use the frozen configuration, have time limits, and a re-run contract. They MUST
  write a checkpoint before any step that may write, and store the command's result. After an unclear result, a command
  whose safe re-run cannot be proven MUST wait for a person.
- **FR-005**: The context of each role MUST include the immutable request/acceptance, the data the step needs, and
  provenance; the fixer gets the related errors, and the reviewer gets the current diff. The system MUST limit size, report
  any truncation, exclude secrets and channel-administration syntax, and keep temporary data out of committed changes.
  If required context is missing, it MUST ask or wait rather than silently truncate and run.

**Scheduling and runner**

- **FR-006**: The daemon MUST be the only component that writes state, and it dispatches effects only after the execution
  intent has been durably recorded. Holding and returning slots follows FR-044; recovery runs before work dispatch per FR-036.
- **FR-007**: The runner MUST have a lifecycle independent of the daemon and manage the whole process tree of an attempt.
  Launch and retry MUST NOT create a duplicate attempt, even if the daemon dies before the process identity is saved.
  Reclaim capability MUST be verified both when the daemon runs in the foreground and under a service manager.
- **FR-008**: Each attempt MUST store the invocation with secrets masked, a process identity strong enough to avoid
  misidentification after reboot or PID reuse, output, liveness/progress, termination, and the result in the standard form
  under the SPEC.md §12 contract.
- **FR-009**: The system MUST distinguish alive from progressing; silence alone is not a stall. Timeout, stall and cancel
  MUST stop the processes belonging to the attempt within a finite time, confirm that no unintended processes remain, and
  MUST NOT stop processes that do not belong to the task. Sleep, restart or a clock change MUST NOT reset the limit.
- **FR-010**: Before each agent call, the system MUST check the resolved role/binding/permission/approval, slot and budget.
  It MUST distinguish a reserved attempt from a used one, and release a reservation only when it is certain the call was not
  made. Repairs, resumes and rate-limited calls all count as used once they have actually happened.

**Harness, quality and permissions**

- **FR-011**: The system MUST support a simulated harness, Claude Code and Codex CLI for coder/fixer/reviewer. Each harness
  MUST have evidence of its version, of its actual permission and limit capabilities, and of its ability to send and receive
  results for each role. A harness that cannot meet a required hard permission or cost cap MUST be rejected before running.
- **FR-012**: Results MUST be checked for structure, semantics and the provenance of the current attempt before use. A
  successful exit, a completion report or a stale artifact MUST NOT be enough to pass a step. The result source and fallback
  MUST follow SPEC.md §12.3; metadata is attached by the orchestrator, and the agent's self-reported ID is not trusted.
- **FR-013**: The coder/fixer MUST write only within its assigned area; the reviewer MUST only read. Detected changes outside
  scope MUST stop for reconciliation; changes the user made in the original repo MUST NOT be automatically attributed to the agent.
- **FR-014**: Required gates MUST pass before review or publish. In `full-review`, the reviewer MUST use its own read-only
  session, and approval MUST be tied to a fixed base SHA and commit SHA after the checkpoint and to the PR content that was
  reviewed. There is no other vendor/model constraint. In this mode, a code change MUST invalidate the related evidence, re-run
  the gates, commit, and be reviewed again. `direct-pr` MUST skip the reviewer according to the mode the user confirmed, and
  MUST NOT fake an approval or infer a skip from size; publishing in both modes MUST match the checkpoint. A gate or formatter
  that changes code MUST re-check the required gate set on the final tree within the safe retry limit. Within the same task and
  revision, valid approvals/findings and all unchanged review inputs MUST be reused; the reviewer MUST NOT be called, and no new
  commit created, just because the worker was a no-op. Changed inputs MUST get a new review under M03/M06, except the
  base-integration scope certification under SPEC.md §14.2. See M01–M08.
- **FR-015**: Every failure MUST be classified per SPEC.md §9.2, and the limits inherited from feature 001 apply: infrastructure
  at most 3 retries; timeout/stall at most 1 retry; invalid output at most 1 repair and 1 new session per rung before escalation
  is considered; auth/refusal waits for a person. Rate limit/infrastructure MUST NOT raise the model for quality reasons; unknown
  MUST wait for reconciliation. The overall cap on attempts and time always takes precedence when it is reached first.
- **FR-016**: Every attempt MUST record the actual binding, harness version, time, outcome, usage and traceable artifacts. Usage
  MUST distinguish reported/estimated/unavailable, and MUST NOT record 0 in place of missing data. Secrets MUST be masked before
  they are saved or exported; logs and context are limited and subject to a retention policy.

**Publish and CI**

- **FR-017**: The orchestrator MUST create the branch and worktree, make a checkpoint commit before review (if any), push exactly
  the SHA that was checked, and create or reclaim the PR on the correct repo/head/base of the task. The worker MUST prepare the
  commit message and PR title/description per the frozen template; artifacts are validated before use. Each logical operation
  MUST have a stable idempotency key and enough evidence to reconcile after a timeout or crash. Agents MUST NOT be granted the
  right to publish or merge on their own in place of the orchestrator.
- **FR-018**: Before retrying a commit, push or PR creation, the system MUST reconcile per SPEC.md §13.2. A remote whose SHA differs
  from the expected one, or multiple ambiguous results, MUST be reported for handling; the system MUST NOT force-push, create a
  replacement PR, or reset the worktree on a guess. A merged PR is handled per FR-040, and an unmerged closed PR per FR-041.
  A reconciliation with missing evidence MUST keep the result as unknown.
- **FR-019**: The CI-wait loop that automatically continues execution MUST have a limit; observation of the PR continues per
  FR-043. The system MUST report a PR as green only when the full list of required checks is available, every check succeeded
  on the current head, the gate passed, and the review is still valid if the mode is `full-review`. `direct-pr` MUST clearly
  show that no review was run. Pending, cancelled, missing or unknown checks, or a list that is not fully determined, MUST NOT
  be treated as a pass. The source of the list follows FR-042; the limit and the behavior on expiry follow FR-043; revoking
  green follows FR-041.
- **FR-020**: A CI failure caused by code MUST go through a limited fix loop, then the required gate and review, and then update
  the same PR. CI infrastructure or flaky failures are re-run only when classification has evidence and policy allows it;
  autofix runs only per the frozen configuration and re-run contract. Each time the head changes, the system MUST wait for new
  CI evidence.
- **FR-021**: When the PR is green, the task MUST be in WAITING/approval, with merge details, manual merge instructions,
  PR/head/base, the set of checks, and the time of the last check. The system MUST NOT dispatch a merge in any mode, including a
  configured yolo; a request to grant merge or yolo permission is rejected as not yet supported. Only actual merge evidence per
  FR-040 moves the task to DONE; observation continues within the window set by FR-041/043.

**Recovery and interaction**

- **FR-022**: Startup MUST acquire exclusive write rights and check state compatibility and integrity before dispatch; if this
  fails, the system MUST report a health error and block work dispatch. The separate recovery steps are in FR-034–036.
- **FR-023**: When the store cannot be written, the system MUST stop emitting new effects, report a health error, and keep the
  data needed for recovery; it MUST NOT report success or "saved, pending" if the data has not been durably written. Results
  from a live runner MUST be kept for later ingestion; unpreserved data MUST NOT be deleted to free up space.
- **FR-024**: A needs_input MUST end the attempt, durably store the question, and move the task to WAITING/human_input; the inbox
  MUST still show the question after a restart. Answering and continuing follow FR-037–039.
- **FR-025**: Cancel the task and reconcile the results. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-025.01** | Cancel MUST block new business effects and invalidate effects that have not yet been dispatched. |
  | **FR-025.02** | Cancel MUST stop the processes belonging to the task within the limit set by FR-009. |
  | **FR-025.03** | Cancel MUST reconcile the effects already sent and the latest PR state before finishing; if a merge is unclear, it keeps waiting for reconciliation. The only exception is `cancel --force` requested by the user (issue 179): it reads the PR one more time, and if that read yields no result, it finishes CANCELLED even though the PR could not be read. This does not apply once a merge has been seen, or when merge evidence is insufficient. |
  | **FR-025.04** | If the merge is confirmed, cancel MUST finish DONE per FR-040 with the note "cancel request arrived too late", including merged_head_unverified; it is CANCELLED only when the PR is unmerged and the effects are clear. |
  | **FR-025.05** | Cancel MUST preserve the diff, commits and PR already created; it MUST NOT close the PR itself, delete the branch, or undo external actions. |

- **FR-026**: Source drift and revision MUST keep the semantics of feature 001: record the drift immediately, let the current
  attempt finish, and block the next business step until a safe boundary. Applying a new revision MUST NOT reset attempt counts,
  rungs or deadlines, and MUST NOT use stale evidence. This feature adds no intake channel for source updates; the executor MUST
  respect drift and revision once the core has recorded them.
- **FR-027**: CLI and explain. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-027.01** | The CLI MUST support task add/show/list/explain/history/logs/confirm/cancel/recheck, inbox/answer, and approve for escalation. |
  | **FR-027.02** | The system MUST provide environment checks and health for this flow; ordinary status information is built by code, not by calling an LLM. |
  | **FR-027.03** | Explain MUST separate the time spent waiting for a slot, and state clearly whether a deadline has not started or how much time remains. |
  | **FR-027.04** | Explain MUST show DONE prerequisites that have merged_head_unverified, with a link to the evidence, even when the dependent task has already run. |
  | **FR-027.05** | For merge_cleanup_pending, explain MUST show the confirmed merge, the processes and effects that are not yet clear, the limits on stopping and reconciliation, and the recheck action; it MUST NOT describe the task as DONE. |
  | **FR-027.06** | Explain MUST show the scope of a live task's branch: the files the branch has changed relative to base, other live tasks in the same project that change the same files, the number of base commits the branch is still missing, and the files that would conflict when integrating the base tip (read with `git merge-tree`). The task list MUST show, for each task: tasks that share files with it, files that conflict with base, and any scope that could not be read. The data is read-only from the local repo (the most recently fetched base ref); it does not fetch, does not call GitHub or an LLM, and runs within a shared time limit shorter than the CLI timeout. A read that is unavailable or exceeds the limit MUST show as unknown, distinct from "none", and MUST NOT break the query (issue 210). |

- **FR-028**: The CLI and service MUST keep the read/operate/admin permission contract, request dedup/version/conflict handling,
  machine-readable output and exit codes of SPEC.md §15.1–15.2. Permissions MUST be checked at the service against a trusted
  source; the sender's name, process markers or the presence of a terminal MUST NOT by themselves prove permission.
- **FR-029**: Every waiting task MUST have a reason, a condition for continuing, and a readable way to end. The CLI explain MUST
  print exactly the exits below for each detail, along with the limits still in effect; recheck MUST NOT skip other blockers.
  Automatic observation remains only within the FR-043 window; after observation_expired, a recheck is needed. Cleanup MUST NOT
  delete unpreserved data; automatically cleaning up a worktree that is waiting for merge is out of scope.

  | Reason / detail | Exit in feature 002 |
  | --- | --- |
  | approval / merge | Merge manually into the target branch → observe or recheck → DONE per FR-040; or cancel. |
  | policy / task_deadline; ci / ci_wait_exhausted; escalation ladder, attempts or budget exhausted | Do not open further attempts or extensions. If there is a PR, merge manually → confirm → DONE, or cancel. If there is no PR yet, only cancel; to redo the work, use task add independently. For ci_wait_exhausted specifically: if CI passes late with all required checks on the exact head, the task moves automatically to approval / merge (FR-043.11). |
  | policy / head_changed | The user returns the branch to the checked head → reconcile again within the limit; or merge manually → DONE per FR-040; close the PR → pr_closed; or cancel. There is no command to recheck or accept a new head. |
  | policy / target_mismatch | Before merge: change the base back to the target branch in the snapshot → reconcile again, or cancel. A merge into the wrong branch is not enough evidence of DONE into the required target. |
  | policy / required_checks_mismatch | Historical waits can still be replayed; the observation after reconciliation against the new check names proceeds automatically, or ci_wait_exhausted applies if the CI window has already expired (a late pass with all required checks on the exact head still moves to approval / merge, FR-043.11). Do not edit the snapshot in place; manual merge and cancel remain valid. |
  | policy / pr_closed | Reopen the PR → reconcile again within the limit; or cancel. A closed PR is not yet terminal. |
  | policy / observation_expired | A finite recheck to update the evidence; if a merge is confirmed, DONE per FR-040. If not merged, merge manually and then recheck, or cancel; do not re-enable polling or extensions automatically. |
  | policy / merge_cleanup_pending | Finish stopping and reconciling within the limit → DONE; when the limit is exhausted, the user handles the unclear part that explain points out, then runs one finite recheck. Cancel does not skip reconciliation or change a confirmed merge into CANCELLED; the workflow and publish do not continue. |
  | policy / execution_slot | Wait for a slot per FR-044 if still eligible; or cancel. |
  | PENDING needs_info / config_invalid, capability_missing | Fix the configuration or capability, then confirm or recheck the task, which reads the latest base; or cancel. Do not retry automatically. |
  | human_input; needs_context/blocked | Answer or supply the missing part through the interaction supported by FR-037–039, or cancel; do not call roles outside scope automatically. |
  | approval / escalation | Approve the exact scope while budget remains, or cancel; approval does not open attempts that have already been used up. |
  | infra / unknown, auth; cooldown | Fix the connection or permission, or wait for a finite cooldown and reconcile again within the limit; or cancel once the effects or merge are clear. A read error does not prove that a merge has not happened. |

  Amend-policy and re-check or acceptance of a new head belong to a later feature. Every merge exit MUST satisfy the repo/PR/target
  branch and the FR-040 evidence; every cancel exit MUST satisfy the FR-025 reconciliation.

**Separately stated requirements on artifacts, permissions and recovery**

- **FR-030**: A complete result or artifact MUST be published only after it has been fully saved; a partially written state MUST
  NOT be read as a complete result.
- **FR-031**: Output MUST be ingested logically exactly once across restarts. A torn last line MUST wait for enough data while the
  attempt is still running; log rotation MUST NOT drop data that has not been ingested or duplicate data already recorded. An
  ended attempt whose result is still truncated MUST be classified as invalid output, and the system MUST NOT wait for more data indefinitely.
- **FR-032**: Secrets and administrative permissions MUST be out of the agent's reach; an agent MUST NOT use the project owner's
  identity or the CLI to grant itself permissions or approvals.
- **FR-033**: The environment check MUST block automatic mode until the required permission limits are proven. A separate worktree
  alone is not sufficient evidence of isolation.
- **FR-034**: Recovery of attempts and effects. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-034.01** | Recovery MUST reconcile each open attempt/effect and reclaim the matching process or result before continuing; if the old attempt is not proven to have ended, it MUST NOT spawn a replacement. |
  | **FR-034.02** | After a durably recorded merge, recovery MUST keep stopping and reconciling per FR-040.09, keep the business block in place, and MUST NOT resume the workflow. |
  | **FR-034.03** | A result that arrives late after merge confirmation MUST only add evidence; it MUST NOT trigger the fixer or a push. |

- **FR-035**: An attempt that is certainly dead but has no result MUST be recorded as lost; it is resumed at most once, and only
  when policy and the session allow it. Recovery MUST NOT reset the diff, attempt counts, rung or deadline.
- **FR-036**: Recovery MUST restore slots, worktree locks and timers, verify that the rebuilt projection matches the committed data,
  and write a report before dispatching new work. If a claim is still unclear or the projection is inconsistent, it MUST block
  work dispatch, keep the evidence, and report a health error.
- **FR-037**: Answering an inbox item MUST check permission and revision, and accept the first valid answer. A repeated request
  returns the old result; a competing answer returns a conflict.
- **FR-038**: After an answer, resume MUST use only the same harness as the valid session, and only if policy allows it. Otherwise
  the new attempt receives the recorded Q&A and still passes the slot, budget and permission checks.
- **FR-039**: Needs_context or blocked MUST record the missing part and the handling path for the user, and MUST NOT be treated as
  done or automatically call a role outside scope.

**PR lifecycle and slot allocation**

- **FR-040**: Completion after a manual merge. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-040.01** | For a task that is not yet terminal, the system MUST durably record reliable evidence of a merge into the correct repo, PR and target branch, the head at merge time, and the merge commit; together with blocking new business and invalidating effects not yet dispatched. |
  | **FR-040.02** | After merge confirmation, the system MUST stop every execution process belonging to the task using the FR-025 mechanism; it MUST NOT create a fake cancel or record "cancel request arrived too late" when no cancel was requested. |
  | **FR-040.03** | The system MUST reconcile every effect that has been sent and record late results. A push already sent may succeed after the merge or after the merge was recorded; the request cannot be recalled. |
  | **FR-040.04** | The system MUST record DONE exactly once, and release dependencies only after the processes are confirmed stopped and every sent effect has a clear result. If that is not yet the case, it MUST be WAITING/policy with merge_cleanup_pending, keep the claim per FR-044, and show the merged state as it truly is. |
  | **FR-040.05** | After the merge is recorded, the system MUST NOT send new pushes or retry publishes. |
  | **FR-040.06** | The system MUST preserve uncommitted diffs and unpublished local commits in the worktree, including those created after the merge. It records the worktree location, local head, what remains, and the remote reconciliation result, and MUST NOT delete, reset or push to make the head match the merged head. |
  | **FR-040.07** | Stopping and reconciling MUST have a timeout, a retry cap, and a separate finite overall deadline set by the plan, and MUST NOT be blocked by the execution deadline or the PR observation deadline. |
  | **FR-040.08** | When the stop/reconcile limit is exhausted with the result still unclear, the system MUST stop automatic attempts, keep merge_cleanup_pending, and allow one finite recheck per FR-046.07; it MUST NOT record DONE or CANCELLED on a guess. |
  | **FR-040.09** | A restart MUST keep the merge evidence, the business block and the remaining limits, so that stopping and reconciling can continue; it MUST NOT reset limits or resume the fixer. |
  | **FR-040.10** | The evidence MUST record the merged head and the head Cuesura checked for the current revision, and state clearly when the checked head was not verified. The checked head does not change because of an external push, and the merge commit need not equal the head because of a squash or rebase. |
  | **FR-040.11** | A head that differs from the checked head, or a task with no checked head, MUST still complete per FR-040.04, with merged_head_unverified and a statement that the quality of the merged head is not certified. Quality evidence MUST NOT be carried over from the old head to the new one. |
  | **FR-040.12** | Missing or contradictory merge evidence, or a wrong target branch, MUST wait in WAITING/policy for reconciliation and MUST NOT be marked DONE automatically; a read error is handled as unknown per FR-041.08. |
  | **FR-040.13** | CI timers, deadlines and observation after merge confirmation MUST keep stopping and reconciling as the next step; they MUST NOT reopen the workflow or replace merge_cleanup_pending. The limits already reached are still stored. |
  | **FR-040.14** | The core MUST accept external merge evidence through poll, recovery, recheck or cancel, including after the execution or observation deadline, without requiring an approval or a fake merge effect. DONE confirms the merge per S01; it grants no permission and no quality certification. |
  | **FR-040.15** | A terminal task MUST NOT be reopened when remote evidence arrives later. |

- **FR-041**: PR observation and the validity of green. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-041.01** | The system MUST observe the PR on the finite schedule of FR-043, including a green PR, a closed unmerged PR, or a PR past the execution deadline; a confirmed merge moves to FR-040. |
  | **FR-041.02** | Green evidence MUST be bound to the revision, the head SHA, the set of checks, and the time of reconciliation. |
  | **FR-041.03** | If the head is changed externally, the system MUST revoke green and move to WAITING/policy with head_changed; it MUST NOT automatically accept the new head, edit code, or overwrite the remote. When review A is still running and the task branch is pushed to B unexpectedly, a late approval or result for A MUST only be recorded with its correct provenance: it MUST NOT clear a blocker, move the evidence to B, or continue publishing. An approval that arrives before the fact drift MUST still pass the remote and blocker guard before publishing; a restart keeps the fact, the blocker, and the intent and receipt. See H01–H06 in the mode contract. |
  | **FR-041.04** | Only a change to the base tip MUST keep the head-bound evidence and the task state. The system MUST NOT automatically update or rebase, call the fixer, or re-run the gate or review. There are two deliberate exceptions, which integrate the base through an execution slot even when yolo is off, per SPEC.md §14.2: a task waiting for merge, and the review/fix loop of `full-review` when a checkpoint that was rejected for review conflicts with the base tip. Each checkpoint MUST record which files would conflict when merging the locally fetched base tip (no fetch; if it cannot be read, the result is unknown and triggers nothing). In the review/fix loop, the base is integrated before the fixer pass that follows review: if there is a conflict, that same fixer pass (one pass) fixes both the conflict and the review findings; if the merge is clean, the gate and certification run before the fixer is called; a new head always goes through review. While waiting for merge, a task with no conflict, or a single fixer pass that only edits the conflicting files, is exempt from new review; anything outside that scope MUST be reviewed. A conflict-fixing pass that errors or does not complete, or that conflicts again after that pass, waits for a person. FrozenPolicy does not change. |
  | **FR-041.05** | A target branch that differs from the snapshot MUST move the task to WAITING/policy with target_mismatch. |
  | **FR-041.06** | A required check that is pending or failing on a valid head MUST revoke green and be handled within the CI limit; the list must match the snapshot and GitHub per FR-042. |
  | **FR-041.07** | A closed PR that is not merged MUST move the task to WAITING/policy with pr_closed, and is observed within the window; if it is reopened, reconcile again; if it is merged, FR-040. |
  | **FR-041.08** | A remote read error MUST return unknown, WAITING/infra, and show the last observation as history. The next observation is scheduled only while the FR-043 window still has time; the system MUST NOT infer that the PR is unmerged. |

- **FR-042**: Source and reconciliation of required checks. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-042.01** | `ci.required_checks` MUST be frozen from `cusr.yaml` per revision; editing the local file does not change the snapshot. |
  | **FR-042.02** | Each CI wait or observation pass MUST read the full branch protection and rulesets currently in effect on the target branch, regardless of the yolo flag. |
  | **FR-042.03** | The list to wait for MUST be the union of the check names in the snapshot and every GitHub check that is currently required, including checks outside the snapshot and app-pinned checks. Order and duplicates do not change the result. |
  | **FR-042.04** | A check outside the snapshot, or one pinned to an app, MUST NOT create a new required_checks_mismatch; its name and app MUST be stored in the evidence. Old schemas, events and waits MUST remain replayable: a task in an old wait reconciles itself and proceeds on a later observation, or gets ci_wait_exhausted if the CI window has expired, except that a late pass with all required checks on the exact head moves it to waiting for merge (FR-043.11). |
  | **FR-042.05** | If GitHub confirms that no rule applies, the system MUST record github_required: none, and still wait for the snapshot checks, gate and review. An empty union at observation keeps the earlier behavior: the task moves to waiting for merge, and no check on the head is used as a fallback. Yolo specifically does not merge, and logs once the guidance to declare `ci.required_checks`. |
  | **FR-042.06** | If GitHub cannot be fully read or permission is missing, the system MUST return unknown, WAITING/infra; it MUST NOT record none, treat the result as matched, or fall back to the project-only list. |
  | **FR-042.07** | An ambiguous mapping of checks MUST wait for policy. |
  | **FR-042.08** | Green only when every check in the union has passed (success, or skipped/neutral as GitHub branch protection treats it when no check on the head has failed or been cancelled), on the exact head, together with a valid gate and review per FR-019. Before the merge effect, app-pinned checks MUST pass from the exact app_id; the system MUST NOT rely on GitHub enforcement, since admins can bypass it. |
  | **FR-042.09** | The union MUST be recomputed on each read pass; it MUST NOT modify the FrozenPolicy, the schema or the snapshot hash. Turning yolo on or off, or a read error in the user config, MUST NOT change the CI or observation list; a broken config only disables merge and is logged per SPEC.md §14.2. |

- **FR-043**: Limits for CI, execution and observation. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-043.01** | The system MUST keep CI and execution wait limits separate from the PR observation limits. |
  | **FR-043.02** | Each observation pass MUST have a timeout and a finite number of transport retries. |
  | **FR-043.03** | The poll cycle MUST back off gradually up to the configured cap, with no hot retries; observation MUST NOT hold a slot or call an agent. |
  | **FR-043.04** | Each observation window MUST have a finite deadline and a finite number of passes. The plan fixes the values, the point from which the deadline is counted, and the backoff schedule. When a window expires or runs out of passes and the last observation shows the PR still open on the task's exact head (no head drift, no cancel), it MUST be replaced by a new window with the same limits, counted from that time (`ObservationExtended`), without needing a person (issue 248). If the window expires and the extension does not read GitHub, the new window reads the PR immediately. |
  | **FR-043.05** | A restart, a successful read, or a recheck MUST NOT reset the observation deadline or create a duplicate poll chain; only an extension under FR-043.04 moves the deadline. |
  | **FR-043.06** | When the observation deadline expires and cannot be extended (the last read shows the PR closed, on a different head, or unknown), the system MUST stop polling and move the task to WAITING/policy with observation_expired, keeping the blocker, the limits already reached, and the last observation. Only one reconciling recheck is allowed; the schedule is not re-enabled automatically. |
  | **FR-043.07** | The reconciliation required for cancel MUST still be done per FR-025 after the observation deadline; it does not restore periodic monitoring. |
  | **FR-043.08** | Each head's CI loop MUST have a time cap and a cap on the number of checks. Reaching the cap moves the task to WAITING/ci with ci_wait_exhausted and stops automatic fixing or re-running for that loop; the cap is not extended. A late pass is handled per FR-043.11. |
  | **FR-043.09** | The task deadline MUST start when the workflow first runs, per SPEC.md §9.4: READY time waiting for the first slot is not counted; time waiting to re-request a slot is counted. It is not paused or reset when a slot is requested or on restart. |
  | **FR-043.10** | When the task deadline expires, the system MUST block new execution work and move the task to WAITING/policy with task_deadline, except for the stop/reconcile stage after merge per FR-040.13. |
  | **FR-043.11** | A late CI pass MUST NOT reset limits or open a fix, re-run or poll pass. A late pass on the exact checked head with all required checks (including after ci_wait_exhausted) MUST move the task to waiting for merge, as if it had passed within the window. Other late results only update the evidence. A confirmed merge is handled per FR-040. |
  | **FR-043.12** | Every state MUST show the last observation, the observation deadline, the next scheduled observation or the reason it has stopped. Stale data MUST NOT be presented as the current remote state; read errors follow FR-041.08. |
  | **FR-043.13** | A confirmed merge or a terminal task MUST stop the PR observation schedule. Stopping and reconciling after the merge follows FR-040.07 and FR-040.13, and is not blocked by CI, execution or observation deadlines, nor does it change the waiting reason. |

- **FR-044**: Execution slots and waiting order. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-044.01** | The daemon MUST allow at most `runtime.concurrency` tasks (default 1) to hold execution slots at the same time. A slot is bound to a task; each task holds at most one slot, and each worktree at most one attempt. A RUNNING task MUST keep its slot through every step and automatic effect (Prepare/setup, agent, gate, autofix, publish, PR creation, review, fix_review, and so on). It MUST NOT release the slot at a step boundary, or while running an effect that does not need a slot. Prepare, setup, gate, autofix and publish, and attempts, run only while the task holds a slot. |
  | **FR-044.02** | A task that leaves RUNNING to wait for CI, merge, a person or a cooldown MUST keep its slot as a reservation when no slot-bound work remains unresolved; if it is waiting because of a pause, deadline, cancel or post-merge cleanup, it releases the slot. A reservation MUST let only one READY task that has never run borrow it at a time. That task MUST have no dependencies, MUST NOT work on the PR of the reserving task, and MUST NOT be skipped per FR-044.08; the number of borrowed tasks MUST NOT exceed `runtime.concurrency`. A borrowing task holds no reservation and cannot lend further, and it returns the borrowed slot when it waits on something external. A CI poll or other GitHub work by the reserving task MUST NOT take the reservation back or reset the deadline. A reservation held for longer than `runtime.slot_reservation_hours` (default 24) MUST become a free slot allocated per FR-044.03. Read-only polling does not occupy a slot, and seeing a merge does not automatically release a claim that is still unclear. |
  | **FR-044.03** | Slot allocation MUST follow priority; then tasks that have already started waiting for execution_slot come before READY tasks of the same priority; then the current slot-request time within the same group. Ties follow the committed event order, not the time the task was created. A task that overlaps in scope is skipped per FR-044.08. |
  | **FR-044.04** | The scheduler MUST NOT preempt a task that holds a slot or is borrowing one in order to give it to another task; prioritizing a task already in progress does not guarantee against slot starvation. A reserving task that returns MUST run immediately on its own slot, temporarily exceeding N. When it runs work that needs a slot, the reservation is reclaimed, and the borrowed slot of that reservation ends permanently: the borrowing task finishes its in-progress work and returns the borrowed slot before the next slot-needing step, then waits for execution_slot as in FR-044.05. |
  | **FR-044.05** | A task waiting for a slot MUST stay READY if it has not yet run, or be WAITING/policy with execution_slot if it has already started; it moves to RUNNING when granted a slot. A task that has already run MUST NOT be sent back to READY or PENDING to wait. |
  | **FR-044.06** | A restart MUST preserve the waiting order, the slot holder, the reservation together with the time it began to be held (so the reservation duration keeps counting), borrowing, unclear claims, and the task's declared scope (so the skipping per FR-044.08 stays the same). |
  | **FR-044.07** | The system MUST record slot-wait time for explain, distinguishing READY before the first run from re-requesting a slot, which has a deadline per FR-043.09. Explain MUST distinguish waiting for a slot, running on its own slot, holding a reservation, and running on a borrowed slot. |
  | **FR-044.08** | When allocating a slot (FR-044.03) and when lending a reservation (FR-044.02), the scheduler MUST skip a task that has never run and whose scope overlaps the scope of a task in the same project that holds a slot (running or reserved) or is running on a borrowed slot; it then considers the next task in order. A skipped task keeps its place in the queue and is reconsidered on a later pass. A task's scope is the set of files its branch has changed relative to base (FR-027.06), matched against the paths or globs declared at `task add` (the `scope` field). A task with no branch yet (or an unreadable branch) and no declared scope has unclear scope; it is neither skipped nor does it block other tasks. A task that has already started and is re-requesting a slot is not skipped. The slot-allocation trigger MUST carry the list of skipped requests, so that the same queue head can be re-read in the same transaction. Explain MUST show the declared scope, the unclear scope, the `scope_overlap` code with the blocking task, and the shared files. `task add`, `task propose` and `task confirm` MUST return that warning when the scope overlaps a task that holds a slot, a reservation or a borrowed slot (issue 240). |

- **FR-045**: Limits on task retry. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-045.01** | The CLI MUST return an unsupported-feature error when task retry is called; it MUST NOT create a retry task or reopen a terminal one. Task retry and its source links are outside feature 002. |
  | **FR-045.02** | To redo work, the CLI MUST guide the user to `task add` to create an independent request through the current triage, configuration and permissions. It MUST NOT add a retry link automatically. This limit does not remove the core retry model of feature 001 or the CLI v1 contract in SPEC.md §15.1. |

- **FR-046**: Recheck by task state. The independent obligations:

  | Code | Requirement |
  | --- | --- |
  | **FR-046.01** | A task recheck MUST require operate permission and request dedup. |
  | **FR-046.02** | For PENDING/needs_info caused by config_invalid or capability_missing, recheck MUST read the latest base and try the snapshot check/fix as confirm does per FR-002; it MUST NOT skip triage, confirmation, dependencies or permissions. |
  | **FR-046.03** | For a task with a PR, recheck MUST reconcile the PR and CI once within a finite limit, store the evidence, and update the state per FR-019 and FR-040–043. |
  | **FR-046.04** | Recheck MUST NOT reset polling, the deadline or the budget; call an agent; send a merge; re-check or accept a new head; or amend the policy. Further fixing is considered only by the scheduler, separately, while limits remain and a slot is available. |
  | **FR-046.05** | While the observation window still has time, recheck MUST keep the automatic schedule unchanged, and MUST NOT replace it or add another poll chain. |
  | **FR-046.06** | After observation_expired, recheck MUST reconcile only once: if a merge is seen, FR-040 applies; if it is still unmerged or unknown, the task stays observation_expired and the evidence and blocker are recorded. It MUST NOT re-enable polling or reopen the expired CI fix loop. |
  | **FR-046.07** | For merge_cleanup_pending, recheck MUST request one finite stop-and-reconcile pass over the open processes and effects, and record the evidence. It marks DONE only when FR-040.04 is met. This action is allowed after the deadline or observation window, but it does not resume the workflow, retry publish, or reset limits automatically. |
  | **FR-046.08** | A recheck of a terminal task MUST NOT reopen the task or emit new business effects. |
### Default merge method

Per [SPEC §14.2](../../SPEC.md#142-merge), a project has an expected `merge.method`, defaulting to `squash`, and allowing
`merge` or `rebase`. Missing objects or keys use the default; a wrong type, a wrong enum value, or an unknown key in a closed
object MUST raise config_invalid. The value is resolved from the frozen base and snapshotted when the task starts. A new config
does not change a running task and does not edit the old snapshot or hash. The loader, the freeze step and `cusr show` already support this key.

In feature 002, the method and squash message from the worker artifact are only proposals for the user. They do not enable a
merge endpoint or permission, and they do not check the method enabled on GitHub as an admission condition. A manual merge that
differs from the configuration, or whose method cannot be verified, still completes when the proof and drain checks pass. The
actual method is recorded only when there is evidence; otherwise it is unknown. A mismatch is an audit item, not a blocker or a
reason for merged_head_unverified. The checked head, the head at merge time and the merge commit remain separate per FR-040.10.
V1, once it has permission to send a new merge effect, checks the allowed method and does not fall back implicitly.

Coverage is added to M02/M05/M08 and T030/T032/T045/T111/T135/T136/T139. It does not open the auto-merge scope of feature 002
and does not replace the existing 117 FR codes.

### Evidence scope and traceability

| Journey in SPEC.md | Story / requirements | Evidence required in feature 002 |
| --- | --- | --- |
| S01–S02 Task assignment, confirmation | US1, US6; FR-001–005, FR-027–028, FR-040 | A real task goes through the CLI to a PR and to DONE after a manual merge; PENDING creates no worktree or agent |
| S03 Gate/review/CI fixes | US2; FR-014–020 | Real gate, review and CI fix loop; attempt limits |
| S04 Asking mid-way | US5; FR-024, FR-037–039 | Inbox and answer are durable across restart; no channel outside the CLI yet |
| S05 Crash between agent and publish | US3; FR-006–009, FR-017–018, FR-022–023, FR-030–036 | Process, git and PR are reclaimed; not relying on core tests alone |
| S06 Quota/infrastructure | US2, US4–5; FR-010–016 | Classification, cooldown and budget with harness results |
| S07 Dependent/parallel tasks | US1, EC-001; FR-001, FR-044 | `runtime.concurrency` per-task slots; reservation and borrowing while waiting on something external; the fix loop waits for a slot; parallel acceptance with a real harness not yet verified |
| S08 Head/base/merge permission changes | US1–2, US5–6; FR-019–021, FR-040–043 | Green revocation; observation of a manual merge; acceptance of automatic merge execution not yet verified |
| S09 Change requests | Edge Cases; FR-026 | Executor respects drift and revision; no decider/overturn |
| S10 Progress/operations | US3, US6; FR-022–023, FR-027–029, FR-045–046 | CLI, health, recovery; full backup/restore not yet available |

The plan MUST clearly specify the new evidence for I02–I09 at the daemon, runner and effect layers, and keep the regression
checks I01–I12 of feature 001. I11 has evidence here only that this feature does not send a merge; it MUST NOT be reported as
having achieved a safe merge outside the system. R1–R6 and R8 of SPEC.md §18 are verified for the relevant parts below; the R7
soak and the full R9 operations remain part of the v1 release milestone.

### Key Entities *(include if feature involves data)*

- **Task / FrozenPolicy / FrozenExecutionContext**: requirements, revision and limits already fixed by feature 001, with the
  actual worktree, branch and PR links added; does not change the state model.
- **Attempt**: one execution of a role with the actual binding and permissions, process identity, progress, result, usage and
  artifact; distinguishes a reserved attempt from a used one.
- **Effect**: an external operation with an idempotency key, execution status and reconciliation evidence.
- **Worktree / Checkpoint**: the work area owned by the task, and the points that preserve content before and after a write step.
- **Artifact**: invocation, log, standard result, gate/review and recovery data with traceable origin.
- **PR/CI evidence**: repo, PR, revision, expected checked head, observed head and base, the frozen set of required checks and
  the result of reconciling it against the GitHub subset (distinguishing none from unknown), the observation time, schedule,
  deadline and stop reason, CI and execution limits, CI and review results, green validity, merged head, merge commit, and
  merged_head_unverified with the non-certification statement where it applies. It is not, by itself, merge permission.
- **Post-merge completion evidence**: the confirmed merge, the business block, open processes and effects and the result of
  stopping and reconciling them, remaining limits, unpublished local diff and commits, and the worktree location. It
  distinguishes the time the merge was recorded from the time of DONE, and is kept across restart.
- **Question / Approval**: an escalation question and approval tied to task, revision and scope, and to the person who may
  answer or approve; inherits the core mechanism.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least two real sandbox tasks go from a request through code, gate and review to a green PR, with the user
  not hand-editing the code: one task uses Claude as coder and Codex as reviewer, and one task swaps the vendor roles. Each
  task's PR, head, quality evidence and waiting-for-merge state can be looked up. After the project owner merges the exact head
  manually, both tasks are recorded DONE with their merge commits. The number of merge requests sent by the system is 0, even
  when the merge result is received several times.
- **SC-002**: The declared gates of at least two different ecosystems run on the sandbox repo. Each ecosystem has one pass sample
  and one fail sample. A fail sample MUST NOT be published before it has been fixed and re-checked successfully.
- **SC-003**: 100% of the cases in which a gate fails, review requests changes, CI fails due to code or infrastructure, there is
  a rate limit, auth failure, refusal, invalid output, or quota exhaustion produce the correct classification and limit result.
  No call exceeds the cap, and no PR is reported green on stale or missing evidence. The sample set covers each case in US2 and US4.
- **SC-004**: At least 200 seeded, reproducible daemon interruptions, spread across launching and receiving agent results, commit,
  push and PR creation, each keep 100% of the committed state. The projection rebuilt from the log after each recovery MUST match
  100% of the saved projection. No attempt, commit or PR of the same logical operation is duplicated, and no preserved change is
  lost. The matrix has break points before an operation, after an external success, and before the confirmation write; it
  distinguishes the number of retry requests from the number of observable effects. The matrix includes a merge that is confirmed
  while the fixer or push is still running, and a crash after the merge is written but before stopping and reconciling finish:
  the business block is kept, late results are received, and completion happens only once (US3.7).
- **SC-005**: For each real harness, at least once the daemon is stopped while an agent is running and then restarted, it
  reclaims the correct attempt and continues to a green PR, without calling a replacement agent for that attempt. A runner that
  survives a restart is verified separately in both foreground mode and service-manager mode.
- **SC-006**: 100% of the timeout, stall and cancel samples stop all processes belonging to the attempt within the configured
  time, and no process outside the task is stopped. A silent but still progressing sample is not wrongly concluded as stalled.
  A sample in which a merge is confirmed while execution is still running must also stop the task's processes. If stopping or the
  effect is not yet proven, the task is not DONE; it keeps merge_cleanup_pending and the finite recheck path.
- **SC-007**: 100% of the tasks waiting in the acceptance suite have a readable reason, continuation condition and limits, and way
  to end. Re-sending an answer or request 2–5 times does not duplicate a decision or an attempt. Covers each detail and exit of
  FR-029 through explain. PENDING configuration or capability errors do not retry automatically; confirm and recheck read the latest
  base; repeated requests do not duplicate the snapshot or work dispatch (US1.8).
- **SC-008**: Both harnesses have acceptance evidence and return correct results for all three supported roles. All invalid,
  truncated and stale samples are correctly rejected. Test secrets do not appear in saved logs or context, or in CLI results, and
  usage without data is represented as unavailable.
- **SC-009**: The acceptance report lists all of I01–I12, S01–S10 and R1–R9, stating for each the scope and evidence, or that it
  has not passed or has not been checked. Simulated tests, integration tests with real processes and git, and smoke tests using
  real accounts and harnesses are distinguished; simulated results are not used to claim a real smoke pass.
- **SC-010**: 100% of the samples in which a green PR then changes head or checks, gets closed, or loses the ability to reconcile
  revoke the green validity correctly and have a reason and a way to continue. A single base-tip change does not revoke evidence
  bound to the head, and does not automatically fix or update the base or re-run checks. A GitHub check outside the snapshot, or
  one that cannot be read, MUST NOT be reported green. A GitHub requirement for a subset, or a confirmation that no rules apply,
  still counts as green when the snapshot, gate and review checks are complete, with none recorded separately from unknown. Polling
  continues through closed PRs, the CI window and the task deadline within the observation window. 100% of the samples in which
  the overall deadline expires stop polling with observation_expired, including across a restart. Backoff does not exceed the cap.
  No agent or re-run is added after the execution limit is exhausted.
- **SC-011**: In a sample of two interleaved tasks, task A waiting for CI or merge does not hold a slot, B runs, and when A needs a
  fix while B is running, A waits in the correct order. For a sample with multiple in-progress and READY tasks: priority comes
  first; within the same priority, in-progress tasks come first; within the same group, the order is by slot-request time (ties
  by event order), not by the time the task was created. At no point does more than one task hold a slot, including across a
  restart. READY tasks that have never run do not consume the deadline. Tasks that re-request a slot after their first run still
  consume the deadline, and once it has expired, no new business work is dispatched. Explain shows the slot-wait time separately.
- **SC-012**: 100% of the samples in which a merge into the correct target branch happens while waiting or while handling a cancel
  end as DONE exactly once, after stopping and reconciling are complete, with evidence. A head different from the checked head
  records merged_head_unverified, both heads, and the statement that the quality of the merged head is not certified. Missing
  evidence or a wrong target branch never results in DONE automatically. Covered: after the execution deadline while polling
  continues, and after observation_expired via recheck; a recheck that finds the PR unmerged or unknown does not re-enable polling.
  A task retry reports "not supported" and creates no task; task add creates an independent request, not linked to a retry. A
  recheck does not reset the budget, send a merge, re-check a new head or call an agent by itself; terminal tasks are not reopened.
  Also covered: a merge while the fixer or push is still running, a late successful push, and stopping or reconciling that stays
  unknown or passes its deadline, followed by a recheck. In these cases no new publish is sent, there is no early DONE and no early
  release of the claim, the local diff and commits are preserved, and the effect result is recorded correctly. Dependencies are
  released only after DONE, including merged_head_unverified; explain for a dependent task shows the unverified mark and the
  evidence link (US1.9–10).

## Assumptions

- The scope of A is fixed by the user, adding an end path for when the user merges into the target branch themselves, including
  a head that differs from the checked head, with merged_head_unverified. Merge execution and yolo belong to a later feature;
  observing a merge and recording DONE belong to this feature.
- This is a broad feature, deliberately combining the end-to-end flow with the recovery and interaction parts it needs. The plan
  MUST deliver in this order: day-1 spike → US1/2/4 with fakes → US3/5/6 and the crash matrix → real smoke test. A fake slice
  passing MUST NOT be treated as completing the whole feature, and the 200-interruption and smoke criteria MUST NOT be dropped to
  quietly shrink the scope.
- Feature 001 is the foundation for decisions, snapshots, budget, and the store, outbox and timers; feature 002 MUST connect to it
  and check regressions against that foundation. The feature 001 report does not yet prove runner, worktree or GitHub behavior,
  so it cannot replace the execution evidence here.
- The environment is one user on Linux/Ubuntu or WSL2, with runtime data on a Linux filesystem. The limit of one executing task is a
  default for accepting the first flow; it does not replace the v1 parallel scope.
- The repo configuration, profiles and credentials are prepared in advance by the operator. This feature's CLI is not yet the full
  CLI v1; do not add a setup wizard, policy administration, or a task source outside the CLI to complete the milestone.
- The SC-001 acceptance suite uses `full-review`. M01–M08 are added for both `direct-pr` and `full-review` with the same vendor.
  The list of CI required checks in the snapshot is not empty, and includes the case where GitHub confirms that no protection or
  rulesets apply. Rules for other profiles still follow SPEC.md; if a profile is not supported, say so clearly before the run, and
  do not infer "unknown check" as "no check".
- A GitHub sandbox repo, permission to run CI, and permission to use both harnesses for smoke testing are needed. If any is
  missing, the corresponding real criteria MUST be recorded as not yet checked. Writing the spec does not run paid agents or publish trial PRs.
- Harness capabilities are an assumption that needs a spike with versions and evidence before the adapter is implemented. This spec
  does not claim that any command flag, auth method, or permission or cost limit has been verified.
- The 200-interruption threshold comes from R1 and is applied to the daemon and effects in this feature. The simulated matrix MUST be
  supplemented by real smoke testing per SC-005. Passing feature 002 does not mean passing the whole v1 Reliability Gate.
- The detailed contracts for the runner, CLI, error classification and baseline inherit SPEC.md §§9, 12–17 and the
  [constitution](../../docs/constitution.md). Design choices and implementation files will be recorded in the plan.
