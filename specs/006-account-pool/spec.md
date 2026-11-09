# Feature Specification: Multiple accounts per harness, switching accounts when quota is exhausted

> Reflects the design at the time it was written; the code is the source of truth.

**Feature Branch**: `006/account-pool`

**Created**: 2026-11-04

**Status**: Draft

**Input**: User description: "Feature 006: manage multiple Claude/Codex (subscription) accounts for the harness,
switch accounts when quota is exhausted." (Number 005 is already reserved for the GitHub channel under spec 003.)

## Context and scope

Today each harness runs with exactly one account. The harness pin records the name of one credential (e.g. `claude-0`),
and each attempt copies that credential file into the private home and deletes it when done. When an account hits its
quota, the engine sets a timer until `reset_at` (Claude) or a finite backoff (Codex) and then reruns **the same
account**. Users with several subscriptions still have to wait, or edit `credential_refs` themselves and create a new
task.

Other tools solve this in two ways: swapping the auth file (simple, but cannot run in parallel), or giving each account
its own config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) as Orca does. cusr already has a private home for each
attempt, so it only lacks the concept of an **account** sitting between the harness and the credential.

Each harness has a **default account**: the account already logged in on the machine that the pin uses, as today. The
default account is used first; cusr only reads its credential and never writes or deletes it. Users add **backup
accounts** with `cusr account add`: each backup account is a separate login into a directory managed by cusr, does not
share credentials with the interactive session or other tools (Orca…), and cusr only writes to its own directory.
Vendors issue a separate OAuth session for each login, so cusr and other tools can use the same subscription without
breaking each other's tokens (spike). When the default account is out of quota or logged out, the
task switches to a backup account.

This feature adds:

1. **Accounts are named entities** belonging to a harness. The default account exists already; users add backup
   accounts by logging in through `cusr account add`, then list, suspend or remove them from the CLI.
2. **Switching accounts on quota exhaustion**: when an attempt is rate-limited, that account rests until the quota
   resets, and the attempt is immediately rerun on another account of the same harness. Only when every account is
   cooling down does it wait for the recovery time as it does today, with a notice so the user knows. Users can also
   change which account is used from the next attempt onward with `cusr account use`.
3. **Credentials stay usable after each run**: a token the harness refreshes during a run must be kept in the
   account's directory, because a refresh token can only be used once; otherwise cusr's next run would be logged out.

Switching accounts is **not** a model or effort change: same harness, same model, same effort, same frozen binding. Nor
is it decided by the agent; code chooses by a fixed rule and records it ([constitution](../../docs/constitution.md) V).

This feature changes one rule of [SPEC.md §6.2](../../SPEC.md): "Rate limit locks the related pool/harness until
`reset_at`" becomes locking the related **account**; a harness is only treated as out of quota when all of its accounts
are cooling down. The plan must include the matching SPEC.md change.

**Out of scope:**

- API-key accounts and cost-based routing (SPEC.md §2.2 deferred until after v1).
- Showing usage against the 5-hour/7-day limits, forecasting quota exhaustion, or proactively switching accounts before
  being rate-limited.
- Per-account capacity and spreading workers across accounts. Parallelism is still decided only by the pool (FR-020);
  spreading load is left to a later feature.
- Load balancing across accounts by usage; selection order follows only the priority the user sets (FR-002).
- Switching to another harness, vendor or model when quota runs out (still under the approved escalation ladder).
- A mode that waits for approval before resuming when an account recovers; to hold a task, suspend the account. To be
  added later if actually needed.
- Sharing credentials with the user's interactive session or other tools (Orca…): pointing an account at an existing
  credential file, reading or writing another tool's directory, importing or syncing accounts from them. The only
  exception is the default account (FR-003), which is read-only.
- macOS Keychain; v1 runs on Linux, where credentials are files (SPEC.md §2.1).
- Multiple users sharing one account.

## Clarifications

### Session 2026-11-04

**Accounts and credentials**

- Q: Which account is used first? → A: The default account, i.e. the account already logged in on the machine that the
  pin uses. Accounts added with `cusr account add` are backups, used when the default account is cooling down or failing
  (FR-002, FR-003).
- Q: Does cusr write to the credential that is logged in on the machine? → A: No; it is read-only, as today. The
  interactive session may therefore still be logged out as before; in that case the task switches to a backup account
  (FR-003).
- Q: Do backup accounts share credentials with Orca or the interactive session? → A: No. Each backup account is a
  separate login into a directory managed by cusr; cusr only writes to its own directory (FR-006).
- Q: Where is a token refreshed during a run kept? → A: In the account's directory, written back immediately when it
  changes (FR-022).
- Q: When two different token copies exist, which one is kept? → A: The one in the source. The attempt's copy is written
  only if the source has not changed since the attempt started (FR-023).
- Q: If re-login yields a different identity, what happens? → A: The credential is not replaced; to change identity,
  remove the account and add a new one (FR-005a). The default account follows the machine: if the user logs into a
  different account on the machine, cusr temporarily excludes it, and `cusr account check` picks up the new identity
  (FR-005a).
- Q: What if writing the credential fails? → A: The new copy is kept in the secret store, the account is temporarily
  excluded, and an operational error is reported until the write succeeds (FR-022a).
- Q: Does removing an account delete its credential? → A: Yes for backup accounts; the default account is only
  unregistered, and the user's files are not touched (FR-008).

**Permissions**

- Q: Who may change accounts? → A: Only `admin`, since accounts are shared across all projects (FR-008).
- Q: What does a read-only project member see? → A: Name, harness, priority and availability; usage figures only within
  projects they can read; identity and paths only for `admin` (FR-007).

**Account selection and waiting**

- Q: Does the pool grow with the number of accounts? → A: No. The pool remains the parallelism cap set by the user
  (FR-020).
- Q: Does a user action beat automatic retry? → A: Yes; each attempt selects based on the state at that moment (FR-010).
- Q: What if an account is blocked for several reasons? → A: Each reason is cleared separately; the account is only
  selectable once all of them are cleared (FR-011).
- Q: Are two accounts on the same subscription backups for each other? → A: No; they share cooldown state (FR-012).
  Adding an account with the same identity is still allowed, with a warning that it does not increase quota.
- Q: How many times is each account tried? → A: Once per retry round; being woken up opens a new round (FR-016).
- Q: If the whole round fails and every recovery time has already passed, what is waited on? → A: The backoff of the
  `rate_limit` class (FR-016).
- Q: Can clearing a cooldown still be overridden by a later quota report? → A: Yes; to block it, suspend the account
  (FR-008).
- Q: Does "rerun immediately" exceed the pool? → A: No; the task only returns to the queue (FR-014b).
- Q: Does waiting on a credential write-back block the task? → A: No; the task uses another account (FR-014, FR-022a).

**Auth errors**

- Q: How many times is a retry made with a new token? → A: Once per consecutive chain of auth errors of the account
  within a task (FR-018).

**Notifications**

- Q: When does a quota-exhaustion episode end? → A: When an account becomes selectable (FR-014a).
- Q: Does the notice update when the episode changes? → A: Yes; the existing notice is edited, and no further message is
  sent (FR-014a).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Task continues on another account when quota runs out (Priority: P1)

The user configures two Claude accounts for the `claude` harness. While a worker is running, the first account hits its
quota. cusr marks that account as cooling down until the quota reset time, and immediately reruns the attempt on the
second account, continuing the old session if there is one. The user does nothing; `cusr report` and the task detail
show which account each attempt ran on and why it switched.

**Why this priority**: This is the core value: a second subscription is only useful if the task does not have to wait
for the first account to recover.

**Independent Test**: Use a fake harness that returns "quota exhausted, resets in 3 hours" for account A; check that the
next attempt runs on account B within the same task, that there is no waiting timer, and that A is recorded as cooling
down until the exact time.

**Acceptance Scenarios**:

1. **Given** the harness has accounts A and B both ready, **When** an attempt on A reports quota exhaustion with a reset
   time, **Then** A is recorded as cooling down until that time and the new attempt starts on B without waiting for a
   timer.
2. **Given** the attempt on A has a saved session, **When** it switches to B, **Then** the attempt on B continues that
   session; the rerun counts as a quota retry, not an escalation.
3. **Given** A is cooling down, **When** another task needs that harness, **Then** that task is given B immediately,
   without trying A first.
4. **Given** A and B are both cooling down, **When** an attempt needs to run, **Then** the task waits with a quota
   exhaustion reason until the earliest reset time among the accounts, as current behavior does.
5. **Given** the vendor does not report a reset time (e.g. Codex), **When** A is rate-limited, **Then** A rests for the
   configured finite backoff and the attempt switches to B immediately.
6. **Given** two tasks are running on A and both are rate-limited, **When** both report back, **Then** A has only one
   cooldown state (the later time wins) and each task is rerun exactly once on another account.
7. **Given** the harness pool is 1, two ready tasks with no dependencies, and the user has just added a second account,
   **When** the scheduler assigns work, **Then** still only one attempt runs; the other task waits for a slot as before.
8. **Given** A and B are both cooling down, **When** a task starts waiting for quota, **Then** a notice exists that
   states the affected task, the time the task resumes automatically, and the states of A and B; at that time the
   attempt reruns automatically on the recovered account, without anyone having to answer.
9. **Given** a task is waiting for the recovery times of A and B, **When** the user clears B's cooldown, **Then** the
   task reruns immediately on B, without waiting for the old time.

---

### User Story 2 - Add and manage accounts from the CLI (Priority: P1)

An account already logged in on the machine is the default account and needs no action. The user adds backup accounts
with `cusr account add` for a harness: cusr runs the vendor's own login flow into a directory managed by cusr. An
account logged in through Orca must still log in once more with cusr if it is to be used as a backup. `cusr account
list` shows whether each account is ready, cooling down until when, suspended, or has a login error. The user can
suspend, re-enable, clear a cooldown manually, change the priority order, log in again, and remove accounts.

**Why this priority**: Without a way to add and view accounts, Story 1 cannot be used; both stories are P1 because they
must ship together.

**Independent Test**: Add two accounts via login (a simulated login flow in tests), run `cusr account list`, suspend one
account and check that the next attempt does not use it; `cusr doctor` reports each account's status without printing
credential contents.

**Acceptance Scenarios**:

1. **Given** the harness pin uses a credential logged in on the machine and no account has been registered, **When** the
   user upgrades or freshly installs cusr, **Then** that credential becomes the harness's read-only default account
   `default`, and run behavior is unchanged.
2. **Given** the user runs `cusr account add claude --name work`, **When** the vendor's login flow completes, **Then**
   account `work` appears in `list` in the ready state, with its credential in its own directory, ordered after
   `default`; the next attempt still runs on `default` if it is ready.
3. **Given** the login flow is cancelled, fails, or produces a credential not in the harness's vendor format, **When**
   adding an account, **Then** the command is rejected with a specific reason, no account is added, and the temporary
   directory is cleaned up.
4. **Given** account `work` is in use by an attempt, **When** the user suspends or removes it, **Then** the running
   attempt finishes; from the next attempt on, `work` is not selected.
5. **Given** an account is cooling down because of quota, **When** the user clears the cooldown manually, **Then** the
   account is selected again at the next attempt, and the action is recorded with its actor.
6. **Given** the caller only has `read` or `operate` permission (including an assistant operating a project), **When**
   calling add/edit/remove/`use` on accounts, **Then** the command is rejected; `list` is still viewable.
7. **Given** the harness has A (highest priority) and B, and an attempt is running on A, **When** the user runs
   `cusr account use claude B`, **Then** the running attempt keeps using A until it finishes, while the next attempt of
   every task runs on B; the action is recorded with its actor.
8. **Given** the user logs in again to A (`cusr account login`) but picks a different identity by mistake, **When** the
   login completes, **Then** cusr refuses to replace A's credential, keeps the old one, and reports the identity change;
   to change identity, remove A and add a new account. For the default account: if the user logs into a different
   identity on the machine, `default` is excluded from selection with an identity-change reason and an inbox item;
   `cusr account check claude default` picks up the new identity and brings it back.
9. **Given** the user adds an account with the same identity as an existing account, **When** the login completes,
   **Then** the account is still added, with a duplicate-identity warning stating that it does not increase quota, and
   the two entries share cooldown state (FR-012).
10. **Given** `default` is logged out (a login error not caused by a source change), **When** a task needs its next
    attempt, **Then** the attempt runs on a backup account, and the inbox has an item for `default`; once the user logs
    in again on the machine and runs `cusr account check claude default`, `default` is used first again, as before.

---

### User Story 3 - Credentials remain usable after every run (Priority: P1)

The harness refreshes login tokens during a run, and the old refresh token stops working. cusr writes the new copy back
to the account's directory as soon as it changes, so the next run and other attempts on the same account are not logged
out.

**Why this priority**: If credentials degrade after each use, more accounts means more points of failure, and an
account that looks ready fails exactly when a switch is needed.

**Independent Test**: Use a fake harness that writes a new token into the credential in the private home; the account's
credential becomes the new copy, the file stays 0600, and after the attempt the private home holds no auth copy.

**Acceptance Scenarios**:

1. **Given** the harness refreshed the credential during a run, **When** the file in the private home changes, **Then**
   the new copy is written to the account's directory immediately, without waiting for the attempt to end; however the
   attempt ends (success, error, cancellation, timeout), the new copy is kept before the private home is deleted.
2. **Given** the credential did not change during the run, **When** the attempt ends, **Then** the account's credential
   is not written back.
3. **Given** two attempts run in parallel on the same account and both refresh the token, **When** both write back,
   **Then** only the first write is kept; the later one sees that the source has changed since it started, discards its
   own copy, and the source is always one valid, complete copy, never a corrupt or half-merged file.
4. **Given** the user logs the account in again through `cusr account login` after the attempt started, **When** the
   attempt writes back, **Then** cusr does not overwrite the new login with the attempt's copy.
5. **Given** the credential copy in the private home is empty, in the wrong vendor format, or has been replaced by a
   symlink (e.g. the harness lost a concurrent refresh and deleted its token), **When** cusr considers writing back,
   **Then** cusr does not copy it back and records the reason on the account.
6. **Given** the harness refreshed the token but the write-back failed (disk full, missing permission), **When** the
   attempt ends, **Then** the new copy is kept in cusr's secret store instead of being deleted, the account is excluded
   from selection and has an operational error; the attempt's results are still saved and the task continues on another
   account; once a write succeeds, the pending-write reason is cleared and the held copy is deleted. If the account is
   suspended in the meantime, it remains suspended.

---
### User Story 4 - A login-error account does not block the task (Priority: P2)

An account is revoked, or its login session expires. The attempt on that account fails because of auth; cusr marks the
account as having a login error, reruns the attempt on another account, and puts "log in again to account X" in the
inbox. When no account is ready, the task waits according to FR-014: it waits for cooling-down accounts to recover if
any remain, and only waits on a person, as the `auth_config` error does today, when no account can recover on its own.

**Why this priority**: With several accounts, one account's auth error should not block a task, but without this story
Story 1 still has value.

**Independent Test**: The fake harness reports an auth error on A; check that the next attempt runs on B, that A is in
the login-error state, and that A is not selected again until the user fixes it.

**Acceptance Scenarios**:

1. **Given** A and B are ready, **When** an attempt on A fails because of auth, **Then** A is marked with a login error,
   the attempt reruns on B, and the inbox has one item for A.
2. **Given** A is in a login error, **When** the user logs A in again with `cusr account login` (same identity) or
   `cusr account check` succeeds, **Then** A returns to ready.
3. **Given** every account is in a login error or suspended, **When** an attempt needs to run, **Then** the task waits
   for a person, with a reason that names each account and how to fix it.
4. **Given** B is cooling down for another 5 minutes, **When** an attempt on A fails because of auth, **Then** A is
   marked with a login error, the inbox has one item for A, and the task waits for B's quota to clear and then reruns on
   B, without waiting for a person.
5. **Given** an attempt on A started with an old token, and while it was running another attempt wrote A's new token
   back to the source, **When** the first attempt fails because of auth, **Then** A is not marked with a login error,
   there is no inbox item, and the attempt is rerun on A with the new token.
6. **Given** the rerun on A with the new token from scenario 5 also fails because of auth, even though the source has
   changed again, **When** the system handles the error, **Then** A is marked with a login error and the attempt switches
   to another account according to FR-014; there is no second try with a new token.
7. **Given** an attempt is running on A and the user has just suspended A (or run `use` on B), **When** the attempt fails
   because of auth and A's source has a new token, **Then** the rerun uses B, not A.

### Edge Cases

- `reset_at` is already in the past or unusually far away: a past time counts as ready; a time further away than the
  configured cap is cut back to the cap and recorded. If the whole round fails with past times, the task waits for the
  backoff before a new round (FR-016).
- The user clears a cooldown while an older attempt on that account is still running and then reports quota exhaustion:
  the account goes back into cooldown per the new report (FR-008).
- The daemon restarts while an account is cooling down: the cooldown state and recovery timer are restored, and the
  account is not treated as ready early.
- An account is removed from the configuration while cooling down or while an attempt is running: the attempt runs to
  completion, and the removed account's cooldown no longer counts toward the harness's wait time.
- The user logs in to the same vendor account under two names: when this is recognized (same identity), `add` and
  `doctor` warn; the two entries share cooldown state (FR-012), so they must not be tried as each other's backup.
- The quota is an organization-wide or model-level quota rather than an account quota: switching accounts may not help;
  each switch is still recorded, and within one round each account is tried only once (FR-016), so there is no immediate
  cycling.
- An attempt is rate-limited after it has already edited files in the worktree: rerunning on another account keeps the
  worktree, as a quota retry does today.
- The reviewer and the worker in the same task use two different accounts: allowed; separating the reviewer's and the
  worker's sessions stays as it is.
- The user logs in again to an account while it is cooling down: a token change with the same identity does not clear
  the cooldown, because quota belongs to the account, not the token; the user clears the cooldown manually if needed.
- An attempt's token is invalidated because another attempt refreshed the same account's token (spike: Claude lets
  exactly one side win when both refresh at once): this auth error does not mean the account is broken; the attempt
  reruns with the new source copy (FR-018).
- The daemon restarts while an attempt is running: if the attempt's private home still holds a refreshed credential,
  recovery writes it back to the source per FR-022 to FR-024 before the private home is deleted.
- An account is removed while an attempt is still running: the account's directory has been deleted, so the refreshed
  copy in the private home is discarded and the directory is not recreated.
- The harness has no account registered and no credential in the pin: cusr reports a configuration error as it does
  today, and does not search the user's home for credentials.
- The default account (FR-003) points to a credential that the user's interactive session also uses: cusr only reads it
  and never writes it back, so when the harness inside cusr refreshes its token, the interactive session or a later cusr
  run may be logged out, as before this feature. The difference is that the task does not get stuck: an auth error on
  `default` moves the task to a backup account (FR-018).
- The user removes `default`: cusr does not recreate it at the next startup, even though the pin still points to the
  credential.

## Requirements *(mandatory)*

### Functional Requirements

**Accounts and configuration**

- **FR-001**: The system MUST let users with several named accounts for each harness; each account belongs to exactly
  one harness. Apart from the default account (FR-003), each account has its own credential directory managed by cusr,
  not shared with other accounts or tools.
- **FR-002**: Each account MUST have a user-set priority, defaulting to `0`; the system selects the ready account with
  the highest priority; on a tie, the default account comes first, then the order of registration. Therefore, adding a
  backup account does not change the account in use.
- **FR-003**: When the harness's pin points to a credential and the harness has never had a default account, the system
  MUST create a **default account** `default` pointing to that credential, both on upgrade and on fresh install, without
  the user editing configuration or recreating the pin; run behavior is unchanged. The default account is the only
  exception that points to a file outside cusr's directory: cusr only reads it, MUST NOT write to or delete that file,
  and cannot log it in again through `cusr account login` (the user logs in through the vendor's CLI as usual). If
  `default` is removed, cusr MUST NOT recreate it.
- **FR-004**: The harness pin MUST no longer be tied to one specific account: adding, removing or changing accounts does
  not require recreating the harness's pin or proof.
- **FR-005**: The system MUST refuse to add an account when the login flow is cancelled or fails, or produces a
  credential that is not a regular file, is empty, or does not match the harness's vendor format, with a specific
  reason; no half-finished account or directory is left behind.
- **FR-005a**: Each account MUST be bound to the vendor identity recorded when it was added (Claude: the account and
  organization in `.claude.json`; Codex: `account_id` in `auth.json`). A token change that keeps the identity is still
  the same account. If re-login yields a different identity, cusr MUST NOT replace the account's credential; to change
  identity, remove the account and add a new one. If the identity in the source differs from the recorded one (this can
  only happen with the default account, when the user logs into another account on the machine), the account MUST be
  excluded from selection, with an identity-change reason and an inbox item; the cooldown state and history do not
  carry over to the new identity. For the default account, `cusr account check` MUST pick up the new identity and clear
  this reason.

**CLI**

- **FR-006**: `cusr account add <harness> --name <name>` MUST run the vendor CLI's own login flow into a new directory
  managed by cusr. `cusr account login <harness> <name>` MUST log in again to an existing account: it logs in to a
  temporary directory, checks the identity, and only then replaces the account's credential according to FR-023. cusr
  MUST NOT accept a path to an existing credential or import accounts from other tools.
- **FR-007**: `cusr account list` MUST show, for each account: harness, priority, state (ready; cooling down until which
  time and why; login error; suspended), number of running attempts, and last-used time. It MUST never print credential
  contents. Because accounts are shared across the whole daemon, the name, harness, priority and availability status are
  visible to any caller with `read` permission; the number of attempts, the last-used time and the list of tasks MUST
  count only projects the caller can read; the vendor identity, credential paths and filesystem error details MUST be
  visible only to `admin`. The same rules apply to `doctor`, report, the TUI and the notices in FR-014a.
- **FR-008**: Accounts are daemon-wide resources shared by all projects. A caller with `admin` permission MUST be able to
  add, suspend, re-enable, clear a cooldown, change priority, `use` and remove accounts; each action is recorded as an
  event with its actor and reason. Per-project `operate` permission MUST NOT be enough for these actions, because they
  affect other projects' tasks; `read` only allows viewing. A dedicated permission that lets an assistant switch accounts
  itself is deferred. Clearing a cooldown only removes the cooldown state known at the time of the action; a quota report
  that arrives later (including from an attempt that started before the action) sets the cooldown again, and the event
  states this reason. To be sure an account is not selected, suspend it. Removing an account MUST delete that account's
  own directory (including any pending write-back copy); for the default account, it only unregisters it and MUST NOT
  delete the user's file.
- **FR-008a**: `cusr account use <harness> <name>` MUST raise that account to the harness's highest priority, so that
  from the next attempt of every task the harness uses this account. The command is only a shorthand for changing
  priority (FR-002, FR-008): it does not stop a running attempt, does not attach the account to a task, and when this
  account is cooling down or in error, the system still switches to another account by priority. The command is rejected
  if the account is suspended.
- **FR-009**: `cusr doctor` MUST check each account (credential present, correct type, file permissions) without printing
  its contents; MUST warn when two accounts share the same vendor identity (no quota gain); and MUST note that the
  default account shares its credential with the interactive session (FR-003).

**Account selection and switching on quota exhaustion**

- **FR-010**: Each agent attempt MUST run with exactly one account, chosen by code immediately before launch; the choice
  is recorded as an event on the attempt. The agent cannot choose or change the account. Every attempt, including
  automatic reruns, MUST choose based on the state and priority at launch time, so that user actions (suspend, remove,
  `use`) always win over the previous attempt's choice.
- **FR-011**: The system MUST select only accounts that are ready: not cooling down, no login error, no identity change
  (FR-005a), not waiting on a write-back (FR-022a), not suspended, and still in the current configuration. The blocking
  causes MUST exist independently, and only the matching action can clear each one: the time passing or clearing the
  cooldown lifts the cooldown; a successful login check lifts the login error; a completed write lifts the write-back
  wait; re-enabling lifts the suspension. Clearing one cause does not make the account ready while another cause remains.
- **FR-012**: When an attempt fails because of quota, the system MUST mark that account as cooling down until `reset_at`
  if the vendor provides it, or otherwise according to the finite backoff of the `rate_limit` class; the cooldown state is
  shared by all tasks. Because quota belongs to the subscription, all entries with the same recognizable vendor identity
  (including entries belonging to other harnesses) MUST share cooldown state; an entry whose identity cannot be read
  cools down on its own. Suspension, login errors and write-back waits remain per entry.
- **FR-013**: After a cooldown is marked, if another ready account of the same harness exists, the system MUST rerun the
  attempt immediately on that account, in the same way as today's quota retry (keeping the worktree, continuing the
  session if there is one), without setting a waiting timer.
- **FR-014**: When an attempt must be rerun (because of quota or auth), the system MUST consider the options in this
  order: (1) if a ready account exists, run immediately on it; (2) if none is ready but some account is blocked only by a
  quota cooldown, the task waits with a quota-exhaustion reason, and the wait time is the earliest moment any account
  recovers; at that moment it reruns on the recovered account, continuing the old session if there is one, without
  needing a person; (3) only when every account is in a login error, an identity change, suspended, or no longer in the
  configuration does the task wait for a person, as `auth_config` does today, with a reason that names each account and
  how to fix it. A user who wants to hold the task instead of letting it run on its own should suspend the account. An
  account waiting on a write-back (FR-022a) also recovers on its own: if only such accounts remain, the task waits with an
  operational-error reason and a backoff, not for a person, and is reconsidered for a rerun when the write completes. If
  both cooling-down accounts and write-back-waiting accounts remain, the system tracks both the recovery time and the
  write result; an account with several blocking causes is ready only when all of them have been cleared per FR-011.
- **FR-014a**: When a task begins waiting at step (2) of FR-014, the system MUST record a notice that states: the harness,
  the affected task, the time it resumes automatically, and the state of each account. The notice is not a question and
  does not require a reply; it appears in `cusr report`, the TUI and the task detail, and goes through the outbox once
  feature 003 exists. Multiple tasks waiting on the same harness during the same quota-exhaustion episode MUST be merged
  into one notice. An episode starts when a task needs the harness, at least one account is blocked only by a quota
  cooldown, and no account is selectable; it ends when a selectable account appears. Tasks still waiting for a slot after
  that are in the normal slot-waiting state and are not part of the episode. The episode has a stable identifier that
  survives restarts, so that the notice is not sent again. The notice MUST reflect the latest state of the episode:
  changes (a task added, a recovery time changed) update the existing notice by the episode's identifier instead of
  creating a new logical notice; when the episode ends, the notice is edited to "an account is available again, the tasks
  are back in the queue", without creating a separate recovery notice. If the episode ends before the first notice is
  sent, that notice is dropped; the history remains in the report and the TUI. If a notice cannot be edited, the reason is
  recorded, retries stop, and no replacement message is sent, as with the 003 outbox. One logical notice may still have a
  duplicate message when a send has an unknown result (`unknown`); the editing rule applies to stored, referenced
  messages, per feature 003.
- **FR-014b**: When an account of a harness returns to ready before its wait time (clearing a cooldown, adding an
  account, re-enabling, `cusr account use`, a successful login check, or lifting a write-back wait per FR-022a/FR-023),
  the tasks waiting on that harness's accounts MUST be rerun immediately according to FR-014, not wait for the old time.
  "Immediately" means dropping the quota wait and returning to the execution queue: still within the pool limit
  (FR-020), and without interrupting running tasks.
- **FR-015**: Switching accounts, or rerunning on the same account with a new token (FR-018), MUST NOT change the harness,
  model, effort or binding, MUST NOT count as an escalation step, and MUST consume the run budget as a quota retry does
  today, whether the reason is quota or auth.
- **FR-016**: Two quota reports for the same account from two attempts MUST merge into one cooldown state (the later time
  wins); each rate-limited attempt produces exactly one rerun. Within one consecutive round of a task's tries, each
  account MUST be tried at most once, except for the single new-token try under FR-018; when accounts run out, the task
  waits according to FR-014, and when it is woken (FR-014b, or at the recovery time) a new round opens. This limit
  prevents immediate cycling, but it does not stop a task from going through several quota-exhaustion episodes within
  one step; every rerun respects the frozen cap if the task has one, as in FR-015; a task without a cap has no mandatory
  total-run limit.
  When a round exhausts all accounts with no future recovery time (e.g. every `reset_at` has already passed), the task
  MUST wait for the `rate_limit` class backoff before opening a new round, not open one immediately; wake-up per FR-014b
  still applies.
- **FR-017**: Account state (every blocking cause in FR-011) MUST survive restarts and be restored before any new work is
  assigned. Replay MUST restore the account choice recorded in FR-010 rather than recalculating it, since the choice
  depends on the time it was made and on the set of accounts at that time.
- **FR-018**: When an attempt fails because of auth and the source credential has changed since the attempt started
  (the token was refreshed by another attempt, or the user logged in again through `cusr account login`), the system MUST
  NOT mark the account with a login error, and MUST allow the account to be selected again using the new source copy.
  This happens only once per consecutive chain of auth errors of that account within a task; the chain ends when an
  attempt on the account runs without an auth error. The rerun still selects accounts according to FR-010, so an account
  that has been suspended, removed, or placed behind another account by `use` is not used again; a new token does not
  clear a cooldown or a suspension. In all other cases, the system MUST mark the account with a login error, not select it
  again until a login check succeeds, create an inbox item for that account, and then rerun the attempt in the order of
  FR-014 (ready accounts first, then accounts waiting on a cooldown, and only finally a person).
- **FR-019**: `cusr report`, the task detail and the TUI MUST show the account of each attempt and each account switch,
  with its reason.

**Concurrency**

- **FR-020**: The number of attempts running at the same time MUST still be limited only by the pool, as it is today.
  Adding, re-enabling or clearing a cooldown on an account MUST NOT increase the number of concurrently running attempts;
  accounts only decide which subscription an attempt runs on. When the pool allows several attempts, they may share one
  account, in the priority order of FR-002.

**Credentials**

- **FR-021**: Each attempt MUST still run in a clean private home; the account's credential is placed there with mode
  0600 and deleted after the artifact is saved, as today.
- **FR-022**: When the harness refreshes the credential in the private home, the system MUST write the new copy to the
  account's directory as soon as the file change is detected, without waiting for the attempt to end, and MUST re-check
  once more before deleting the private home, however the attempt ends, including when the daemon restarts midway. Early
  writing is mandatory: the spike showed that when two attempts refresh at the same time, the loser fails auth at once,
  and FR-018 can only rescue it if the winner's copy is already in the source. The default account (FR-003) is never
  written back. Apart from the held copy in FR-022a, cusr keeps no other copy of an account's credential.
- **FR-022a**: When a write-back fails (e.g. disk full, missing permission), the system MUST NOT delete the refreshed
  credential copy: the copy is kept in cusr's secret store with 0600 permissions, the obligation to write it back
  survives restarts, the account is excluded from selection, and it has its own operational error. The attempt's results
  are still saved as usual, and the task continues its later steps (gate, reviewer…) on another account; an account
  waiting on a write-back does not hold a slot. A successful write (from an automatic retry or requested by `admin`) only
  lifts the write-back wait (FR-011) and deletes the held copy. At write time, if the source has changed, FR-023 applies;
  if the account's directory has disappeared, it MUST NOT be recreated and `admin` is notified. The held copy is deleted
  when `admin` removes the account.
- **FR-023**: Every replacement of an account's credential (a write-back from an attempt, or a re-login) MUST be atomic,
  locked, and never leave a corrupt file. The system MUST write only when the source is still the copy the writer
  received at the start; if the source has changed, it keeps the source, discards the writer's copy, and records an event
  with the reason, without guessing which copy is newer from the time the attempt ended. Because only cusr writes to the
  account's directory, cusr's lock is enough to guarantee this.
- **FR-024**: The system MUST NOT copy a credential back from the private home if it is no longer a regular file, is empty,
  does not match the vendor format, or belongs to an identity other than the account's; in that case it records the
  reason on the account.
- **FR-025**: Credential contents MUST NOT appear in events, logs, reports, CLI output or notices.
### Key Entities

- **Account**: one login to one vendor identity, used for one harness: already logged in on the machine (the default
  account), or logged in by cusr (a backup account). Attributes: name, harness, the credential directory managed by cusr
  (or the user's file, for the default account), the vendor identity recorded when it was added, priority, and the
  suspension state set by the user. It is a daemon-wide resource and does not belong to any project.
- **Account state**: the set of independent blocking causes (cooling down until which time, and caused by which attempt,
  with the time coming from the vendor or from a backoff; a login error from which attempt; an identity change; a
  pending write-back; suspension); empty means ready. The cooldown state belongs to the vendor identity; the other causes
  belong to each entry. It is shared by all tasks and survives restarts.
- **Quota-exhaustion episode**: a period during which every usable account of one harness is cooling down. It has a
  stable identifier, used to merge notices in FR-014a.
- **Account choice of an attempt**: which account an attempt runs on, when that was chosen, and whether it is the first
  run or a switch from another account, with the reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With two accounts and one account rate-limited, the next attempt starts on the remaining account within 30
  seconds of the quota error being recorded, without going through a quota wait timer, when a pool slot is free and the
  other launch conditions are met.
- **SC-002**: In the fake test suite, 100% of account switches keep the same model, effort and binding, and none counts
  as an escalation.
- **SC-003**: After 50 consecutive attempts on one backup account, each of which refreshes the credential, the account
  is still logged in; the user's interactive session and Orca, on the same subscription (with a separate login), are not
  logged out. The default account is not part of this criterion: it shares its credential with the interactive session,
  so it keeps its behavior from before the feature (FR-003).
- **SC-004**: With 10 attempts on the same account ending at the same time, the account's credential is always one valid,
  complete copy (0 corrupt-file occurrences in 100 test runs).
- **SC-005**: The user adds an account with one login command and sees it ready in `cusr account list`, without editing
  configuration files, recreating the pin, or restarting the daemon.
- **SC-006**: An existing account configuration keeps working after an upgrade without any changes, and gives the same
  results as the existing test suite.
- **SC-007**: Checking the events, logs, reports and CLI output after a run that switched accounts finds no token or
  credential contents.
- **SC-008**: Restarting the daemon while an account is cooling down does not let that account be selected before its
  recovery time.

## Assumptions

- The subscription quota is tied to the logged-in account: when account A is rate-limited, account B of the same vendor
  usually still works. If that is not the case (e.g. an organization-wide limit), FR-016 and the edge case on the number
  of switches keep the behavior no worse than today.
- The account set is a runtime resource, not a policy: it is not frozen into the task. Adding an account takes effect from
  the next attempt of every task; removing or suspending an account stops it being selected. This matches the fact that
  the pin does not currently record a digest for auth, because auth changes by itself. Binding, model and pool remain
  fixed per revision.
- Claude reports `reset_at` through `rate_limit_event`; Codex currently does not, so Codex accounts cool down by the
  finite backoff of the `rate_limit` class. Reading Codex's reset time is a later improvement and does not block this
  feature.
- Continuing a session on another account relies on sessions being copied between private homes without copying auth;
  the assumption is that the vendor accepts resuming a session created by another account. This is not yet verified
  (spike S1); if a vendor does not allow it, the rerun on another account starts a new session.
- Credentials are files on Linux (`.credentials.json` for Claude, `auth.json` for Codex with the file store). If Codex is
  configured to store credentials in a keyring, that is not supported, and `doctor` reports it clearly.
- Login uses the vendor CLI's own login flow (`claude auth login`, `codex login --device-auth`), run interactively in the
  user's terminal; cusr does not perform OAuth itself. Vendors allow several simultaneous logins into one account, each
  with its own refresh token (spikes S3, S4).
- Token refresh behavior has been verified by the spike: refresh tokens for Claude and Codex rotate after each refresh;
  Claude lets only one side win when both refresh from the same refresh token, while Codex accepts both within the tried
  window (spike-report.md).
- This feature does not depend on feature 003. The inbox item in FR-018 is an account item in the existing inbox, visible
  only to `admin`; once 003 exists, that item and the notice in FR-014a go through the outbox like any other item that
  needs a person.
