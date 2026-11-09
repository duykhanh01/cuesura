# Cuesura Constitution

This constitution governs every specification, plan, task and line of source code in Cuesura (`cusr`).
Operational details live in [SPEC.md](../SPEC.md); when the two documents conflict, the constitution
wins and SPEC.md must be fixed.

## Core Principles

### I. Deterministic orchestration core

- Every state transition and next-step decision MUST be made by pure code. There is no
  continuously running Primary AI; an LLM must not act as event handler, scheduler or decider of
  task state.
- `decide` and `evolve` MUST be pure functions: the same state, workflow, policy and recorded input
  yield the same events/commands; no I/O, no clock reads, no random number generation. `now`, IDs and
  jitter are created outside the engine and recorded when needed for replay.
- Event order MUST come from the committed sequence, not be inferred from IDs or system time.
- Routine status and usage reports MUST be built by code from recorded data, without calling an LLM.

**Rationale:** orchestration costs 0 tokens, every decision is explainable and reproducible, and property
tests can cover the decision space broadly.

### II. Effects after commit, idempotent, recoverable

- A single daemon (`cusrd`) MUST be the only writer of the state store. The CLI, assistant, runner and adapters
  do not write to the database directly.
- A trigger MUST be accepted in one transaction (dedup, events, projection, outbox,
  timers). External effects run only after commit; a transaction does not spawn, call the network or `await`.
- Every logical operation MUST have a stable idempotency key. An unclear result after a timeout/crash MUST be
  reconciled by a probe before retrying; a probe lacking evidence returns `unknown`, which is not treated as
  "did not happen".
- The sole exception to the above: sending or editing a notification to a channel without reliable idempotency or
  probing (SPEC.md §13.2) MAY be retried after an `unknown` result, accepting that the user sees duplicates. Every
  duplicate MUST carry the same notification code, question or request, and acting through any copy MUST resolve
  to the same object. The exception MUST NOT apply to decisions, approvals, merges or any effect that changes
  external state beyond displaying a message.
- A restart MUST reclaim in-flight attempts, PRs and effects instead of creating a second copy; it does not spawn
  a replacement until the old attempt is proven to have ended; it does not reset a worktree merely because HEAD
  diverges from the checkpoint.

**Rationale:** a crash at any point must not lose committed state or repeat a push, PR,
comment or merge that already succeeded.

### III. Bounded loops, tasks without a budget

- Loops between steps (`max_visits`) MUST have a cap. A task's caps (step visits, attempts per rung, retries,
  budget and deadline when present) are retry caps before the task waits; when a cap is hit, the deputy or a person
  with permission MAY reopen them with a command that carries an actor and a reason. Deputy calls have no cap and do
  not count toward any budget or cap of the task. Agent turns, wall time and
  budget of a task have no mandatory cap; infrastructure retries use increasing backoff and a count cap is
  optional. Old tasks keep their frozen caps: no attempt starts once that cap is exceeded. When policy requires
  approval (rung `needs_approval`), an attempt MUST NOT start without a valid approval, i.e. one bound to the correct
  task/revision, step, rung and policy hash. An `auto` rung does not wait for approval.
- A waiting task MUST have a reason, a condition for continuing and a path to completion. Terminal states do not
  reopen themselves; a retry after termination creates a new task linked to its source.
- Usage MUST distinguish `reported`, `estimated`, `unavailable`; never record 0 in place of missing data.
  Do not commit to a hard USD cap for a harness whose cost-limiting mechanism has not been verified.

**Rationale:** stopping a worker mid-job because the budget ran out costs more than letting it finish; the workflow
still terminates thanks to `max_visits`, and usage is still recorded so the user can see it and cancel when needed.

### IV. Evidence, not the agent's word

- A successful exit code or the agent saying "done" MUST NOT be enough to pass a step. The result must match the schema,
  belong to the right attempt and pass every gate required by the confirmed policy/mode.
  `full-review` MUST have a review; `direct-pr` does not require review, does not fake approval evidence
  and does not waive gates/CI or grant merge permission.
- Required checks in a pending, cancelled, missing or unknown state MUST NOT be treated as passing.
- The reviewer MUST use a session separate from the coder and receive only the data it needs (a size-limited
  diff). The reviewer MAY edit and run checks in the worktree; its changes MUST NOT enter the task: the daemon
  MUST durably record a checkpoint before it runs and restore the worktree to that checkpoint, even after a daemon
  restart. The vendor/model may be the same as the coder's; a different vendor is not preferred by default.

**Rationale:** agents can be confident and wrong; only verifiable signals move the workflow forward.

### V. The user stays in control

- Workflow, policy, role/model binding and original input MUST be immutable per revision. Changes require an
  event, an actor, a reason and a new revision. An agent MUST NOT change its own role, permissions, binding, approval,
  pool or budget. An assistant caller declares itself as `assistant` (`CUSR_ACTOR`) and the daemon limits it to
  `read`/`operate`: it may confirm the run config of a task it orchestrates, by digest and with the actor recorded,
  may approve escalation within the frozen ladder (issue 205), may amend the policy of the waiting step
  (`amend-policy`: a model in `allow_models` and the rung state of the profile, budget, deadline), and may not approve
  adopting an existing PR or use admin permissions. The deputy (actor `deputy`, attached by the daemon when it launches
  it) has the same `read`/`operate` permissions, MUST record a reason for every write and MUST NOT confirm the intake
  or run config of any task. This
  is a guardrail for callers that follow the convention, not a security
  boundary against processes with the same UID. Workers do not call `cusr`.
- Code only raises effort/model/vendor along a pre-approved ladder, triggered by failure classification.
  Infrastructure errors or exhausted quota MUST NOT trigger a model upgrade; no silent model downgrade. Outside the
  ladder, changing the model of a waiting step only goes through `amend-policy` by an `operate` caller or the owner,
  with an event, actor and reason.
- A merge effect sent by Cuesura MUST be performed only by code after checking permissions, head/base SHA,
  gates/CI, review per mode and approval for the merge operation. Auto-merge under `full-review` MUST have
  reviewer approval; `direct-pr` auto-merges when gates and CI are green, with no reviewer reading the diff. The
  deputy and agents do not decide merges. The user
  may merge manually on GitHub according to permissions/branch protection; Cuesura MUST reconcile evidence of
  that external action, without faking approval/review and without requiring the merge to pass the internal
  effect's guard. By default a person approves each merge into a protected branch; yolo mode
  can only be enabled by an admin user through a trusted channel, never through the repo's `cusr.yaml`, and is
  re-checked at the moment the merge is dispatched.
- The deputy acts for the user on a task: the daemon only calls it when the task has entered a wait that the routing
  table assigns to the deputy; spec questions and worker requests only go to the deputy when the user enables
  `autonomous` through a trusted channel. Waits about credentials, harness refusals, boundary violations, merges and
  task confirmation always go to a person. The deputy MUST NOT merge, enable yolo or adopt an existing PR. A user's
  action wins over a deputy's action. Every deputy action MUST be recorded with a reason and be explainable;
  reversing it means the user acts further, reverts or creates a new task, and the deputy does not pretend to undo
  external side effects.

**Rationale:** policy, cost, write permissions and merges belong to the user; results across runs
must be comparable.

### VI. A core neutral to domain, language and vendor

- The engine MUST NOT contain knowledge of programming languages, build tools, model providers or task intake
  channels. Gates, setup, log filters and resources are declared per repo in `cusr.yaml`;
  harnesses, task sources and communication channels are adapters with contracts.
- Adapters MUST NOT decide retries, escalation or task state.
- Every task from every source MUST be normalized and deduplicated into one format before entering the engine.

**Rationale:** software development is only the first use case; adding a new workflow, harness or repo
must not require changing the engine.

### VII. Verification through tests and honest reporting

- Each invariant I01–I12 in SPEC.md MUST have evidence at the layer that can actually verify it:
  - Decision logic (`decide`/`evolve`, policy, escalation, budget): property tests with
    fast-check.
  - Store, outbox, timers and recovery (single writer, atomic transactions, idempotency, sequence):
    integration tests on real SQLite, with crash injection.
  - Runner, executor, worktree and merge: contract tests with an injected Clock, fake ports/harness and
    fixtures. Real harnesses run in separate smoke tests.
- Property tests of the pure engine MUST NOT be used as evidence for invariants that live in the I/O layer.
- Typecheck, lint, test and build are separate checks; one being green does not substitute for another.
- A gate or acceptance criterion that has not passed MUST be reported as not passed; it must not be replaced by a
  simulated check and treated as equivalent. Assumptions without evidence (spikes) MUST NOT be presented as
  existing features.

**Rationale:** reliability is the product's core value; it only exists when it is measured and reported truthfully.

### VIII. Simple, not speculative

- MUST NOT add a durable-execution framework, message broker, database server, ORM or DI container
  merely to prepare for scalability that is not yet needed.
- Features outside the v1 scope in SPEC.md MUST NOT be implemented early; scope cuts must state the
  narrowed version and must not lower the reliability standard of the rest.
- Complexity beyond the baseline MUST be justified in the plan's Complexity Tracking section.

**Rationale:** the project was built to replace tools with hundreds of modules not wired into the main flow;
every component must actually be used.

## Technical and security constraints

- **Stack baseline:** Node 24 LTS, strict TypeScript (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`, `noEmitOnError`), ESM built with
  `tsc`, SQLite via `better-sqlite3` behind a thin store module, Zod 4, Commander, `yaml`, Vitest,
  fast-check, pnpm with a frozen lockfile, ESLint + typescript-eslint + Oxfmt. Changing the baseline requires an
  amendment to SPEC.md §17.
- **Exhaustiveness:** a switch over a domain union ends with `assertNever`; no casting to `never`.
- **SQLite:** WAL, `synchronous=FULL`, foreign keys, a finite busy timeout; unique constraints protect
  event sequence, source dedup, request ID and effect idempotency key.
- **v1 environment:** a single user, Linux/Ubuntu or WSL2, worktrees and runtime data on a
  local Linux filesystem.
- **Trust boundary:** `read`/`operate`/`admin` permissions MUST be checked in the application service.
  Per the project owner's decision of 2026-11-01 ([ADR-0005](adr/0005-native-harness-permissions.md)),
  Cuesura runs harnesses directly in a dedicated worktree, without an outer bwrap. Sandbox and tool permissions
  MUST be managed by the harness: auto review/approve by default, full access only when the owner chooses it
  explicitly in the pin. The Claude worker sandbox MAY be turned on/off independently of the permission mode,
  off by default; the reviewer uses the fixer's boundary.
  The deputy runs with the harness's full permissions; its changes in the task's worktree MUST NOT enter the task:
  the daemon MUST durably record a checkpoint before each turn and restore the
  worktree to that checkpoint after the turn, even after a daemon restart, as with the reviewer.
  No promise is made to prevent a same-UID process from reading home/secrets or accessing sockets/metadata outside
  the worktree. A worktree is not a security sandbox. Workflow, approval and merge permissions MUST remain intact.
- **Secrets:** redacted before storing or emitting logs. A secret a command needs to run MUST NOT pass through a
  redacted artifact; it is delivered through a dedicated file with mode 0600 in the run dir, which the runner deletes
  before spawning and the daemon deletes when the run does not start, and no other file holds the plaintext. No
  blind force-push; no deleting a worktree that still holds unpreserved data.

## Development process and quality gates

- Features follow the Spec Kit chain: specify → clarify → plan → tasks → implement. The plan MUST have a
  "Constitution Check" against principles I–VIII before and after design.
- Changes to source code or executable configuration (package, tsconfig, lint/test configuration, schema,
  migrations) MUST pass typecheck, lint, test and build. Changes touching the engine, store, outbox,
  recovery or merge MUST include tests at the corresponding layer per principle VII.
- Documentation-only changes MUST pass checks appropriate to documentation: internal links still valid,
  I/S/R/§ codes matching SPEC.md, no remaining placeholders.
- When a check does not yet exist (for example during bootstrap with no source code or scripts yet), the report
  MUST mark that check as "not available" with a reason; it must not be treated as passing.
- Reliability Gate R1–R9 in SPEC.md §18 is a mandatory condition for releasing v1. The fake group runs
  automatically; smoke tests with real harnesses are separate because they consume usage.
- Each journey S01–S10 MUST be traceable to acceptance evidence.

## Governance

- This constitution takes precedence over every other document and habit of the project. Reviews of specs, plans and
  PRs MUST confirm compliance; violations MUST be fixed before merge, unless there is a valid exception.
- Complexity Tracking is only used to justify complexity beyond the baseline (principle VIII), for example
  adding a dependency, project or abstraction layer. It MUST NOT be used to waive any other MUST/MUST
  NOT requirement.
- An exception to a MUST/MUST NOT requirement is valid only when the project owner explicitly approves it and it is
  recorded in the feature's plan, including: the principle and clause waived, scope, reason, risk, compensating
  measures and exit condition. No exception may relax requirements on permissions, approval, merge,
  secrets or non-repetition of side effects (principles II, V and the trust boundary); changing those
  requires a constitution amendment.
- An amendment requires: a description of the change, the reason, its impact on SPEC.md and the Spec Kit templates,
  and a Sync Impact Report. Only the user (project owner) approves amendments; agents do not edit the constitution
  on their own.
- Versioning follows SemVer: MAJOR when removing or redefining a principle incompatibly;
  MINOR when adding a principle/section or materially expanding one; PATCH when clarifying wording.
- Detailed operational guidance lives in [SPEC.md](../SPEC.md) and
  [docs/architecture.md](architecture.md).

**Amendment 2026-11-01 (project owner):** 2.0.0 → 3.0.0 because the mandatory access boundary is replaced
by the harness's native permissions, including the owner's full access option. The scope is tool execution on the
host; principles II/V on idempotency, application permissions, review and merge are not replaced. Synced SPEC §15.2,
the execution contract and the runbook; the templates read the current constitution and need no structural change.

**Amendment 2026-11-01 (project owner):** 3.0.0 → 4.0.0 because principle III is redefined and run config
confirmation in principle V is relaxed: removed the mandatory caps on agent turns, wall time and task budget, including
the infrastructure retry count cap already removed in issue 47; the `operate` token may confirm run config. Unchanged:
the user merges PRs, review and gates per mode, the run config digest, `max_visits`, admin `task approve` for escalation
rungs that need approval. Synced SPEC §5.2, §9.4, the `cusr` skill, the runbook and dogfooding; the templates read the
current constitution and need no structural change.

**Amendment 2026-11-01 (project owner):** 4.0.0 → 5.0.0 because `direct-pr` may auto-merge under yolo, without a
reviewer. Cuesura is still the code that sends the merge after checking; agents do not call merge and do not decide merges.
Synced SPEC §14.2 and I11, the runbook; the templates read the current constitution and need no structural change.

**Amendment 2026-11-03 (project owner):** 5.0.0 → 6.0.0 because principles III and V are redefined for the decider:
removed the call-count cap, replaced with a rule against back-and-forth questioning (except with the `grill` label), and
reversal means a revert or a new task. Unchanged: the decider grants no approval, does not merge, and does not change task
state beyond answering worker questions. Synced
SPEC §10 and the runbook; the templates read the current constitution and need no structural change.

**Amendment 2026-11-03 (project owner):** 6.0.0 → 6.1.0 because the exception already in SPEC §13.2 is brought into
principle II: notifications to a channel that cannot be probed (Telegram) are resent after an `unknown` result with the
same code, accepting duplicates. Unchanged: every other operation must still probe before retrying; decisions, approvals
and merges are never repeated because of duplicate messages. SPEC.md is unchanged because §13.2 already states this rule
correctly; the plan of feature 003 cites the new clause; the templates read the current constitution and need no
structural change.

**Amendment 2026-11-04 (project owner):** 6.1.0 → 6.1.1 replaces Prettier with Oxfmt in the
stack baseline to unify the formatter and format checking. SPEC §17 is synced; the Spec Kit templates
do not specify a formatter and keep reading the current constitution, so no edits are needed.
The typecheck, lint, test and build gates remain mandatory.

**Sync Impact Report 2026-11-04:** the technical baseline changes Prettier → Oxfmt; principles
I–VIII unchanged. SPEC §17 and the formatter guidance are updated; Spec Kit templates checked, no
change needed. No pending sync items.

**Amendment 2026-11-05 (project owner):** 6.1.1 → 7.0.0 because the way principle V separates the assistant
from the owner is redefined: access tokens are removed. A caller declares its actor via `CUSR_ACTOR`; it does not
declare itself as owner. Access to the control socket relies only on file mode (directory 0700, socket 0600), as was
already the case in practice, since a same-UID process could read `owner.token` anyway. Per-token project scope is
removed. Unchanged: the assistant has only `read`/`operate`, does not approve escalation, does not enable yolo; the user
merges PRs. Synced the runbook, the `cusr` skill, dogfooding, the CLI–daemon contract and ADR 0011; the templates read
the current constitution and need no structural change.

**Sync Impact Report 2026-11-05:** principle V changes the owner/assistant separation mechanism from tokens to a
self-declared actor. SPEC §5.2 and §15, `deploy/README.md`, `docs/dogfooding.md`, the `cusr` skill, README and
`specs/002-task-to-green-pr/contracts/cli-daemon.md` are updated; Spec Kit templates checked, no
change needed. No pending sync items.

**Amendment 2026-11-06 (project owner):** 7.0.0 → 8.0.0 because principle IV and the trust boundary are redefined: the
reviewer is no longer read-only but runs like the fixer, allowed to edit, run checks and commit; the daemon durably
records a HEAD/working-tree checkpoint before it runs and restores the worktree to that checkpoint, so the reviewer's
changes do not enter the task. Only the decider keeps a read-only sandbox.
Also clarifies the secret delivery path for commands: not through redacted artifacts, a dedicated 0600 file deleted
before spawning. Unchanged: the reviewer uses a separate session, approval is bound to a specific SHA, the decider and
agents do not decide merges. Synced SPEC §7, §9, §14 and §15.2, the execution contract, ADR-0005, the runbook; the
templates read the current constitution and need no structural change.

**Sync Impact Report 2026-11-06:** principle IV and the trust boundary change the reviewer's permissions and the secret
delivery path. `SPEC.md`, `specs/002-task-to-green-pr/contracts/execution.md`, `docs/adr/0005-native-harness-permissions.md`,
`deploy/README.md` and `docs/architecture.md` are updated; Spec Kit templates checked, no change needed.
No pending sync items.

**Amendment 2026-11-08 (project owner):** 8.0.0 → 9.0.0 because principle V is redefined: the assistant (`operate`) may
approve escalation (`task approve --kind escalation`), which is no longer the owner's job alone. Reason (issue 205): the
approved rung is already in the ladder the user configured and is frozen into the policy, and a self-declared actor is
not a real permission boundary, so requiring admin only leaves the task waiting on a mechanical step. Unchanged: the
engine still checks the open request, revision, step, rung, policy hash and budget; approving adoption of an existing
PR, enabling yolo and admin permissions still belong to the owner; agents do not merge. Synced SPEC §5.2 and §15, the
CLI–daemon contract, TUI and Telegram, the runbook, dogfooding, the `cusr` skill, README and ADR-0011 (PR 225); the
templates read the current constitution and need no structural change.

**Sync Impact Report 2026-11-08:** principle V moves escalation approval from `admin` to `operate`.
`SPEC.md`, `specs/002-task-to-green-pr/contracts/cli-daemon.md`, `specs/004-terminal-tui/contracts/tui.md`,
`specs/003-telegram-channel/contracts/telegram.md`, `deploy/README.md`, `docs/dogfooding.md`, `README.md`,
the `cusr` skill and `docs/adr/0011-declared-actor-instead-of-tokens.md` were updated in PR 225; Spec
Kit templates checked, no change needed. No pending sync items.

**Amendment 2026-11-08 (project owner):** 9.0.0 → 10.0.0 because principles III, V and the trust boundary are
redefined for the deputy (feature 007, spec in PR 253): the deputy replaces the decider, acting for the user on a task
when the task enters a wait that needs a person. Principle III: a task's caps are retry caps before waiting, which the
deputy or a person with permission reopens with a command carrying an actor and reason; deputy turns have no cap and
are outside the budget; removed the decider's one-answer-per-step rule and the `grill` label. Principle V: actor
`deputy` has `read`/`operate` like the assistant, must record a reason, does not confirm tasks; the assistant and deputy
may `amend-policy` (change the model within `allow_models`, budget, deadline of the waiting step); changing the model
outside the ladder only goes through `amend-policy` with an actor and reason. Trust boundary: the deputy has full
permissions, and changes in the task's worktree are restored to the checkpoint as with the reviewer. Unchanged: the
engine decides every state transition (principle I), code is the only party that sends merges, the deputy and agents do
not merge, do not enable yolo, do not adopt existing PRs, and credentials and refusals always go to a person. The
existing decider remains compliant because it is narrower than the deputy, until feature 007 replaces it.

**Sync Impact Report 2026-11-08:** principles III, V and the trust boundary change for the deputy. The sync work is done
together with the implementation in slice F of feature 007, so that operational documents do not describe behavior that
does not yet exist: `SPEC.md` §4 (I09), §9.3, §10, §14.1, §15.1, §15.2; `deploy/README.md` section Autonomous; ADR-0005;
a new ADR for the deputy's interaction turns (replacing ADR-0006 specific to this role); `GLOSSARY.md`;
`docs/architecture.md`; `specs/003-telegram-channel/spec.md`; the `cusr` skill.
Spec Kit templates checked, no change needed. Pending sync items: the documents just listed.

**Version**: 10.0.0 | **Ratified**: 2026-10-27 | **Last Amended**: 2026-11-08
