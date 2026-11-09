# Cuesura

Domain terms used to describe agent orchestration, run limits and changes to a task's requirements.

## Language

**Adopt PR (adopt)**:
An admin's approval for a task to continue on an already-open PR, bound to a specific head SHA. The task pushes commits to that PR's own head branch, fast-forward only; it does not open a new PR and does not edit the PR title or description. If the head changes after approval, the task stops at `head_changed`; a PR held by a live task, a PR from a fork, or a PR with a different base is rejected.
_Avoid_: Takeover, stacked PR, self-adopting a PR

**Harness account**:
A named entry declaring a vendor login identity for a harness to use when running an attempt. Each harness has one default account and can add fallback accounts. Several entries can point to the same identity; changing a token does not change that identity.
_Avoid_: Token, credential file, independent subscription, binding, pool

**Default account**:
The account already logged in on the machine that the harness pin is using. It is chosen before fallback accounts of the same priority; Cuesura only reads its credentials, never writes or deletes them.
_Avoid_: Inherited account, the vendor's primary account, account logged in by Cuesura

**Fallback account**:
An account the user adds by logging in through Cuesura into a separate directory managed by Cuesura; used when the default account is in quota rest or has a login error. It does not share credentials with interactive sessions or other tools.
_Avoid_: Vendor sub-account, credential copy, account imported from another tool

**Quota rest**:
A period during which an account is not chosen because it has hit its usage quota, with a time at which it is reconsidered. Quota rest belongs to the subscription identity and is shared by the entries, harnesses and tasks using that identity; if the identity has not been recognized, that entry rests on its own.
_Avoid_: Broken login, suspended, holding a slot

**Pending credential write**:
The state where a fallback account has refreshed login information that could not yet be saved back to the account's directory, so it is not yet chosen for new attempts. This state does not lose the work results the attempt already has.
_Avoid_: Quota rest, failed task, login error

**Account availability**:
Whether an account entry can be chosen for a new attempt; this holds only when no blocking cause remains. Removing one cause does not mean removing the others.
_Avoid_: Enabled means usable, out of rest means usable

**Quota exhaustion episode**:
A waiting period of a harness that has tasks to run, at least one account blocked only by quota, and no selectable account. The episode ends when an account becomes selectable, even if tasks are still waiting for a slot.
_Avoid_: Delivery round, time a task has not run, time waiting for a slot

**Account trial round**:
The sequence of consecutive account selections before a task has to wait for a recovery condition. A task woken after the wait opens a new trial round.
_Avoid_: The whole step, the whole task, one attempt

**Execution mode**:
The choice of how a task's result reaches a PR, confirmed by the user before running. The two modes are `direct-pr` and `full-review`.
_Avoid_: Task difficulty, inferring the mode automatically from size

**Dispatch rules**:
Guidance declared in `dispatch.yaml` next to the user config, or `cusr.dispatch.yaml` at the repo root to replace the whole global file for that repo, so the assistant can propose a profile, execution mode and binding for a task. Both files may only choose what the user config has declared and what the profile allows. The daemon validates the choices every time it reads them but does not read the conditions and does not choose on its own; the user still confirms each run.
_Avoid_: Automatic routing, choosing a model by size

**Direct PR (`direct-pr`)**:
The mode that takes changes through the gate and publishes the PR without calling a reviewer; CI checks and merge permissions still apply.
_Avoid_: Skipping checks, self-merge

**Full review (`full-review`)**:
The mode that requires an independent reviewer to check the change before publishing the PR; independent does not require a different vendor.
_Avoid_: Mandatory two vendors, self-review within the coding turn

**Effort**:
The reasoning level chosen for the model in one run, within the range the harness supports.
_Avoid_: Thinking (another name for the same field)

**Run configuration confirmation**:
The user's consent for a task with a specific harness, model, effort and mode, including the reviewer when needed.
_Avoid_: Agent proposal, confirmation flag self-declared by the agent

**Reserved agent call**:
A portion of quota set aside for an expected agent call that has not yet been confirmed as actually made. This portion is not available for other calls; it is returned only when it is certain the agent did not run.
_Avoid_: Used agent call, free call when the result is unclear

**Used agent call**:
An agent call confirmed to have actually happened, including repair, resume or a rate-limited call. A reserved call becomes used when this confirmation arrives.
_Avoid_: Reserved call, counting only successful calls

**Source drift**:
A change to the source requirement after the task has started executing, which needs the user to decide how to apply it. This change does not automatically replace the revision the task is working on.
_Avoid_: Automatically updating the running requirement

**Safe boundary for revision**:
The point where the task has no running attempt and every related effect has a known outcome, allowing the user to decide to continue the old revision, apply the new revision or create a new task.
_Avoid_: As soon as source drift is detected, merely the agent having stopped emitting logs

**Apply new revision**:
The choice to replace the requirement being worked on in the same task at the safe boundary, keeping the existing diff, the budget used, the model rung and the deadline. The task is triaged and executed again from Code; evidence from the old revision is not used to approve the new revision.
_Avoid_: Creating a new task, continuing the old revision, resetting the task

**Cancel request arriving too late**:
A cancel request for which reconciliation has already confirmed the task's merge; the task is recorded as DONE together with the cancel request history. This request does not undo the merge; reversing the change is a separate revert process.
_Avoid_: Task cancelled but still merged, cancel means revert

**Green PR**:
A PR whose gate and required CI checks have passed for a specific head SHA, plus review if the mode is `full-review`, with the check list fully reconciled. The evidence states the mode; it is not merge permission, DONE status, or a guarantee that the branch is up to date with the latest base.
_Avoid_: Task finished, allowed to self-merge, green forever for every change to the PR

**Execution slot**:
One of the `runtime.concurrency` run slots, granted to a task rather than to each step. A running task keeps the slot through all automated work (preparation, agent, gate, publish, PR creation, review…) and does not release it at step boundaries. A task that leaves the running state to wait for a human, CI, merge or cooldown keeps the slot as a reservation (at most `runtime.slot_reservation_hours`) and runs immediately when it returns; meanwhile a task that has never run may borrow the spot. A never-run task whose scope (files changed on the branch plus declared scope) shares files with a task holding a slot or a borrowed spot is not granted a slot or a borrowed spot. A task that is paused, past its deadline or being cancelled releases its slot. The worktree is always kept.
_Avoid_: Slot of one step, an unfinished task, releasing a slot means deleting the worktree, a borrowed spot that is reserved or lent onward

**Checked head**:
The PR head SHA for which Cuesura has the full gate, CI and review (if required by the confirmed mode) for the current revision. This head does not change on its own with external pushes.
_Avoid_: Current PR head, latest head on the remote

**Assistant lease**:
A marker indicating which assistant session is receiving messages about tasks that need a human, to relay them to the user. The lease only routes messages; it grants no permissions and does no orchestration; losing the lease loses no facts because the work needing a human is rebuilt from the tasks.
_Avoid_: Primary, permission lock

**Registered assistant session**:
A session that holds the assistant lease and is woken by a hook when a task needs a human, without having to run `cusr assistant wait`. Registration survives daemon restarts, and it too only routes messages and grants no permissions.
_Avoid_: Main assistant, orchestrating session

**Logical notification**:
One thing that needs to be reported to the user, such as a question waiting for a human, a task that just finished or a quota exhaustion episode. A notification keeps its identity across every retry, content update, recovery and restart, so the same thing never becomes two logical notifications even though it may appear as several messages.
_Avoid_: Chat message, every send is a notification

**Delivery round**:
The group of delivery attempts of one logical notification sharing one attempt limit and one deadline. If the round ends without delivery, the notification is recorded as failed; only when the channel recovers is a new round opened.
_Avoid_: A single attempt, unlimited retries

**Delivery attempt**:
One attempt to deliver the content of a logical notification to a channel. A delivery attempt can succeed, fail or have an unknown outcome.
_Avoid_: Delivery round, message

**Message**:
A concrete copy of a logical notification currently shown on a channel, for example a Telegram message. A delivery attempt with an unknown outcome followed by a resend can create several messages for the same notification; all messages refer to the same question or request.
_Avoid_: Logical notification, each message is a separate item

**Final state sync**:
The obligation to edit the messages already shown on a channel to match the handling outcome (answered, approved, expired), even after the question or request has closed. This obligation is independent of sending new notifications.
_Avoid_: Resending the notification, outcome notification

**Uncertified merge**:
A manual merge confirmed at a head other than the checked head, or when there is no checked head yet. The task is still DONE because the merge happened, but Cuesura does not certify the quality of the merged head.
_Avoid_: Bad merge, failed task, green PR
