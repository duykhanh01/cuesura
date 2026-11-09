# Feature Specification: Two-way notification channel via Telegram

> Reflects the design at the time it was written; the code is the source of truth.

**Feature Branch**: `003/telegram-channel`

**Created**: 2026-11-03

**Status**: Draft

**Input**: User description: "Feature 003: two-way notification channel. Notifications are sent through an
at-least-once outbox; duplicate sends keep the same question/effect ID. Telegram sends questions, approval
requests and reports, and receives replies and approve commands; map `chat_id` to a grant; answering on one
channel marks the other channel as answered; a failing channel does not change task state. The GitHub part
(issues, comments, GitHub user mapping) and task delivery via Telegram belong to feature 005; scheduled
digest reports are deferred."

## Context and scope

After features 002 and 004, the project owner only learns that a task needs them when they sit at the machine
running the daemon: they open `cusr`, check `cusr inbox`, then reply or approve via CLI/TUI. When they are away,
`autonomous` mode (decider) can only resolve the worker's questions. Model escalation approvals, task
confirmations, and any decider question the decider cannot answer stay pending until the user returns to the
machine. `cusr report` shows what happened, but can only be read on that machine.

This feature adds a **default communication channel** per [docs/architecture.md §8.6b](../../docs/architecture.md):

1. **Outgoing notifications via the outbox**: every item the user needs to know about or act on is durably
   written as a notification with a stable logical key before it is sent. Resending after an error or restart
   keeps the same key and the same question/request ID, so any duplicate message (if one occurs) never doubles
   a decision ([SPEC.md §13.2](../../SPEC.md)).
2. **Two-way Telegram**: questions, approval requests, confirmation requests and notifications needing attention
   are pushed to a private linked chat. The user replies, presses the approve/confirm buttons, or views `/inbox`
   and `/report` directly in the chat.
3. **One source of truth for all channels**: actions from Telegram go through the same service, the same
   permission checks, revision checks and dedup as the CLI. The first valid action wins; messages in other
   channels are updated to "handled".

Telegram is an **adapter**: it only receives, authenticates, normalizes, dedups and sends through the outbox.
It does not decide retries, escalation or task state, and channel errors do not change task state
([constitution](../../docs/constitution.md) II, VI).

**Out of scope:**

- Everything related to GitHub issues: receiving tasks from issues, Q&A comments on issues, the `/cusr` command,
  label/status sync, and mapping GitHub accounts to grants. This belongs to feature 005.
- Submitting new tasks via Telegram (SPEC.md §2.2: Telegram v1 does not accept new tasks). Feature 005 handles
  this after the SPEC is revised.
- Scheduled digest reports (e.g. 7 a.m.). This feature only prepares notification keys so that this source can
  be added later without changing the outbox (FR-005).
- Deciding source drift via the channel: source drift only arises when a task's source is edited, i.e. from
  GitHub issues in feature 005.
- Merge approval, turning yolo on/off, turning `autonomous` on/off, cancelling tasks, changing run settings, and
  `task retry` via Telegram. These stay in the CLI/TUI or in user config as they are today.
- Webhooks or public endpoints; Slack, Discord, ntfy, email; group chats, multiple chats or multiple users;
  quiet hours and customizable notification levels.
- Calling an LLM to compose, summarize or interpret messages.

## Clarifications

### Session 2026-11-03

- Q: Split the two-way channel and task delivery into two features, or merge them? → A: Split. Feature 003 covers
  the notification outbox and two-way Telegram, and is accepted in full with tasks from the CLI/assistant. All
  GitHub parts and task delivery via Telegram move to feature 005, which reuses 003's receive path and identity
  mapping.
- Q: Are scheduled digest reports part of 003? → A: No. 003 returns a report only when the user asks for one,
  built in code like `cusr report`. The notification key has the form type/scope/period, so a future scheduled
  report is just a new notification source.
- Q: When `autonomous` is on, is the worker's question pushed to Telegram right away? → A: No. A question is
  pushed when it waits for a person: the decider does not run for that task, the decider run fails, or the
  decider's runs at that step are used up. The decider's answer is visible via `/report`.
- Q: Does Telegram have a button to reject an escalation? → A: No. In the core, rejecting an escalation leaves
  the task waiting with no way forward; to run again you must cancel and create a new task, so a reject button
  would give nothing beyond not approving. The approval message has only an "Approve" button and states the way
  out if the user does not want to raise the model. No `task reject` command is added.
- Q: When a channel recovers, are notifications that failed to send resent automatically? → A: Yes, but only for
  items that still need a person (questions, approval/confirmation requests that are still valid): one new
  bounded round of resends, with the same key and the same ID. Failed informational notifications (task waiting
  on something that cannot be acted on from Telegram, task finished) are not resent; view them via `/inbox` or
  `/report` (FR-030).
- Q: Does a new link receive pending work? → A: Yes. After a successful link, the still-valid questions, approval
  requests and confirmation requests within the permitted scope are sent; the history of finished tasks is not
  pushed again (FR-031).
- Q: Does the Telegram chat's permission depend on the CLI token that created the link? → A: No. The link has its
  own grant, managed by an admin, which does not exceed the creator's permissions at creation time. Revoking the
  CLI token does not revoke the link. Revoke with `cusr telegram unlink`; change permissions by linking again
  (FR-009, FR-011).
- Q: What does the inbox contain? → A: Every item that needs a person, shared by the CLI and Telegram: questions,
  approval requests, confirmation requests, and other reasons tasks wait on people. Each item states its type and
  whether it can be acted on in Telegram or requires the CLI/TUI. Question items keep the existing fields
  (FR-024).
- Q: Is the "Confirm" button a blanket agreement? → A: Yes. The button only appears when a complete proposed run
  settings exists; pressing it confirms both the task and exactly the run settings shown. If the revision or
  digest has changed, everything is rejected; nothing is half-recorded (FR-016).
- Q: After a question has been handed to a person, can the decider reclaim it after a restart? → A: No. A
  question with a recorded failed decider run keeps waiting for a person across restarts; the decider only looks
  at the next question under the current rules. Turning `autonomous` on after a question was sent only lets the
  decider answer questions with no recorded failed run, and the message is updated per FR-022 (FR-021).
- Q: Does linking the same chat again invalidate old messages? → A: Yes. Each link is a validity boundary.
  Replies and buttons on messages from the previous link, and unprocessed incoming messages received under the
  previous link, are rejected as stale and gain no new permissions; pending work is resent per FR-031. Messages
  sent after the new link use the current permissions (FR-010).
- Q: What is the lifecycle of the link code and the active link? → A: The old chat stays active until the new code
  is used successfully; then the link is replaced in a single write. Creating a new code cancels the pending one;
  `unlink` cancels the pending code too. A code keeps the role/scope fixed at creation until it expires, is used,
  or is cancelled; revoking the source CLI token does not cancel the code (FR-009, FR-010).
- Q: How does a new token for the same bot differ from changing bots? → A: A new token for the same bot keeps the
  link, the read position and the message references. A different bot revokes the link and the old code, drops
  unprocessed messages from the old bot, starts a new read position, and requires relinking; the new bot receives
  the pending work per FR-031 (FR-008).
- Q: Is `/start` an exception to the rule of ignoring strangers? → A: Yes, and only it: `/start <code>` in a private
  chat enters the link flow and receives a generic reply about the result. All other messages from unlinked people
  are still ignored (FR-018).
- Q: What evidence permits opening a resend round? → A: Only evidence that the send path has worked after a
  failed notification; receiving messages successfully or restarting does not count. The system checks its own
  send capability at a bounded cadence; each recovery opens at most one bounded round per failed notification;
  a restart does not reset the limit. The check method and thresholds are set by the plan (FR-030).
- Q: Does a notification that was never sent expire if the daemon stops? → A: The send deadline counts from the
  first attempt. A notification that has never been attempted is still sent after a restart. A round that has
  already started counts the daemon's downtime toward its deadline; when the deadline passes, FR-030 applies
  (FR-002).
- Q: If the original message is deleted, where does the approve button come from? → A: An item actionable in
  Telegram can be reopened from `/inbox` as the current action card, with full scope and buttons. This does not
  depend on the original message and does not create a new business request (FR-015, FR-024).
- Q: Does "no half-confirmation" also cover crashes and storage errors? → A: Yes. A task confirmation and its run
  settings are either both recorded or neither, including when the process dies or a write fails midway. The plan
  must prove this at the transaction layer; checking before writing is not enough (FR-016).
- Q: If `autonomous` is turned off and then on again, can the decider retry a question whose run failed? → A: No.
  A question with a recorded failed run always waits for a person (FR-021).
- Q: If editing a message to its final state fails, can it be recovered? → A: Yes. Syncing the final state is a
  separate obligation, retried in a bounded round when the channel recovers, even if the question/request is
  already closed. It is not a resend of an informational notification (FR-022, FR-030).
- Q: What if a message has a stored reference but was deleted? → A: If the target no longer exists or is
  determined to be unmodifiable, record the outcome with its reason and stop trying; do not resend the history.
  Items still pending open a new card via `/inbox`. Acceptance distinguishes temporary errors from targets that
  cannot be updated (FR-022, SC-008).
- Q: Can `unlink` stop a request that has already left for the network? → A: The revoke commit is the boundary.
  Operations committed earlier stay in effect; uncommitted operations are blocked if the revoke commits first.
  No new send request is started over the old link, but a request already emitted may reach the chat late
  (FR-010).
- Q: With more than 100 items, can the phone see them all? → A: Yes. `/inbox` is paginated so every item can be
  viewed and its card opened; it does not just report that the list was cut and force a return to the computer.
  The pagination method is set by the plan (FR-024).
- Q: Does a question the decider is currently handling appear in `/inbox`? → A: Yes, marked "decider is working on
  it", and the user can answer right away; the first valid answer committed wins. Showing an item in the inbox
  does not generate a push notification (FR-021, FR-024).
- Q: Must action responses queue behind older messages that are in backoff? → A: No. Responses to the user's
  actions take priority; stale messages are skipped; ordering is kept only among still-valid business
  notifications of the same task (FR-006).

## User Scenarios & Testing *(mandatory)*

The primary user is the **project owner** who runs Cuesura on their own machine and wants to reply to and approve
from a phone. **Strangers** (unlinked Telegram chats, group chats, other Telegram users) are actors who must be
ignored.

### User Story 1 - Link Telegram and check the channel (Priority: P1)

The project owner creates a Telegram bot, runs `cusr telegram setup` to enter the token, then runs
`cusr telegram link` to get a one-time link code and sends that code to the bot from a private chat. From then on,
this chat receives notifications and can act within the permission scope chosen at linking. `cusr doctor`,
`cusr status` and `cusr telegram status` show whether the channel is healthy or broken, and why.

**Why this priority**: Without a safe link there is no channel to use. Linking is also where it is decided who may
give orders to the system.

**Independent Test**: On a simulated Telegram, run setup with a correct and a wrong token; link with the correct
code, an expired code, a reused code, and a code sent from a group chat; check the grant, the `doctor`/`status`
output, and that strange chats are ignored. Then repeat once with a real bot.

**Acceptance Scenarios**:

1. **Given** the user has `admin` permission, **When** they run `cusr telegram setup` and enter a valid bot token,
   **Then** the token is stored in the Cuesura data directory, outside every worktree, with file permissions that
   allow only the owner access; it must not enter the agent's context, environment variables or artifacts, and it
   must not appear on screen, in logs or in `--json`. The command reports the bot name it verified and the limit
   of token protection per FR-008. A wrong token reports an error and stores nothing.
2. **Given** a bot has been set up, **When** the user runs `cusr telegram link` (default role `operate`,
   `--role admin` to allow approval), **Then** the CLI prints a one-time code with an expiry, plus a link that opens
   the bot with the code already filled in, and waits. Sending `/start <code>` to the bot from a private chat within
   the expiry (or opening the link and pressing Start) links that chat to its matching grant. The CLI and the chat
   both report success, and the chat then receives the pending items that are still valid within its permission
   scope (FR-031).
3. **Given** the code is wrong, expired, already used or cancelled, **When** the bot receives `/start <code>` from a
   private chat, **Then** nothing is linked; the chat receives one generic reply, "code invalid or expired", without
   stating the reason. The same message sent from a group chat, or any other message from an unlinked chat, gets
   no reply at all.
4. **Given** a chat is already linked, **When** the user runs `cusr telegram unlink`, or a new code is successfully
   used (by another chat or by the same chat), **Then** the old link is replaced in a single write. Replies and
   buttons on messages from the old link, and unprocessed incoming messages received under the old link, are
   rejected as stale. Unsent notifications no longer go to the old link. Until the new code is used, the old chat
   keeps working normally.
5. **Given** the token has been revoked, the bot has a webhook, or another process is also reading the bot's
   messages, **When** the user runs `cusr doctor`, `cusr status` or `cusr telegram status`, **Then** the output
   states that the Telegram channel is unusable, the reason, the consequence (no notifications, CLI/TUI only) and
   the fix. The daemon keeps running normally with the CLI.
6. **Given** the bot is linked, **When** the user runs `cusr telegram setup` again with a new token, **Then** a token
   for the same bot keeps the link, the read position and the sent messages. A token for a different bot revokes
   the link and the old code, drops unprocessed messages from the old bot, and reports that the user must link again.

---

### User Story 2 - Answer the agent's questions from Telegram (Priority: P1)

When a worker needs information and a question is waiting for a person, the project owner receives a Telegram
message that states the project, the task, the question ID, the content and how to answer. They reply to that
message, and the task continues without opening the computer. If they already answered via CLI/TUI, the Telegram
message is updated to "answered".

**Why this priority**: This is the main reason for the channel (SPEC.md S04): tasks do not stall waiting for a
person while the user is away.

**Independent Test**: Have a simulated harness return `needs_input`; check that the message is sent, then answer
from Telegram and from the CLI, resend 2 to 5 times, and answer competitively between the two channels.

**Acceptance Scenarios**:

1. **Given** a linked chat has permission on the project, **When** a new question waiting for a person has been
   durably saved, **Then** exactly one message is sent to the chat, with the project, the task title, the short
   question ID, the content and the answering instructions. The question still appears in `cusr inbox`.
2. **Given** the question message on Telegram, **When** the user replies with text, **Then** the answer is recorded
   for that exact question and revision through the same service as `cusr answer`, with the Telegram identity as
   the actor. The task continues per feature 002, and the bot's reply confirms that the answer was recorded.
3. **Given** the question was answered via CLI/TUI or by the decider, **When** the answer is recorded, **Then** the
   stored Telegram messages referencing that question are edited to "answered", with the answerer, the channel and
   the time (FR-022). A reply to any copy of that question later, including a duplicate that cannot be edited,
   receives an "answered" response and records no new answer.
4. **Given** two answers from Telegram and the CLI arrive at almost the same time, **When** they are processed,
   **Then** the first valid answer wins. The other side receives "answered" together with information about the
   winner. No extra attempt is made.
5. **Given** the same reply is received repeatedly (after a restart or a resend), **When** it is processed, **Then**
   only one answer is recorded and only one logical confirmation message exists.
6. **Given** the question belongs to an older revision, or the task has ended, **When** the user replies, **Then**
   the answer is rejected with a stale reason and is not put into the context of the new revision.
7. **Given** `autonomous` is on, **When** the worker asks a question, **Then** no message is sent while the decider
   is handling it. Only when the question moves to waiting for a person (the decider did not run, failed, or ran out
   of runs at that step) is the question message sent, as in scenario 1. Meanwhile, `/inbox` still shows the question
   with the note "decider is working on it", and the user can answer right away; the first valid answer committed
   wins.
8. **Given** the decider failed and the question has moved to waiting for a person, **When** the daemon restarts,
   **Then** the decider does not run again for that question. The question keeps waiting for a person, and no
   second message is sent.

---
### User Story 3 - Approve and confirm from Telegram (Priority: P1)

When a task is waiting for an escalation approval or for run confirmation, the project owner receives a message with
the full scope and the matching buttons. One press is enough; a stale button never applies to a new scope.

**Why this priority**: Without remote approval, escalations and new tasks stay blocked until the user returns to the
machine, even when `autonomous` is on.

**Independent Test**: Create a task waiting for escalation approval and a task waiting for confirmation; press each
button, press repeatedly, press a stale button after the revision/rung/policy/run settings have changed, and press
from a chat that only has `operate` permission.

**Acceptance Scenarios**:

1. **Given** a task is waiting for escalation approval, **When** the notification is sent, **Then** the message states
   the task, the revision, the step, the rung, the proposed model and effort, and the remaining attempts/rungs, with an
   "Approve" button bound to exactly that scope. The message states that without approval the task keeps waiting, and
   that to drop it the user must cancel the task with `cusr task cancel` and create a new one.
2. **Given** a chat with `operate` permission, **When** "Approve" is pressed, **Then** the approval is recorded through
   the same service as `cusr task approve --kind escalation`, bound to the task and revision, step, rung and policy
   hash. The message is edited to "approved".
3. **Given** a chat with only `read` permission, **When** it receives an approval request, **Then** the message has no
   approve button, states that `operate` permission is required, and shows the matching CLI command. A forged press
   (a callback built by hand) is rejected for lack of permission, and no approval is recorded.
4. **Given** a button was sent for rung N, **When** the revision, the rung or the policy changes before it is pressed,
   **Then** the press is rejected as stale, the message is edited to "stale", and no approval is applied to the new scope.
5. **Given** a task is waiting for confirmation (a task created by the assistant, or run settings not yet confirmed),
   **When** the notification is sent, **Then** the message states the task, a summary of the acceptance criteria, and the
   proposed run settings, with a "Confirm" button bound to that exact revision and run-settings digest. Pressing it
   confirms the task and those run settings together, once, as `cusr task confirm` with the digest. Pressing again
   returns the earlier result. If the revision or the digest has changed, everything is rejected, and no standalone task
   confirmation is recorded. If there are no complete proposed run settings, the message has no button and instead points
   to the CLI/TUI; changing the settings works the same way.
6. **Given** an approval request was handled via CLI/TUI, **When** that is recorded, **Then** the stored Telegram messages
   for it are edited to their final state and their buttons are removed. A button on a message that cannot be edited is
   still rejected under scenario 4.

---

### User Story 4 - Attention notifications and on-demand reports (Priority: P2)

The project owner is notified when a task needs them but no action is possible in Telegram (e.g., a configuration error,
the loop limit reached, a PR waiting to be merged), and when a task ends. They type `/inbox` to see pending work, and
`/report 8h` to see what happened, the same as `cusr inbox` and `cusr report`.

**Why this priority**: Questions and approvals (US2, US3) unblock stuck tasks. This part helps the owner keep track of
the situation without guessing, and it still has value without them.

**Independent Test**: Emit a sequence of state transitions (waiting on a person for several reasons, DONE, FAILED,
CANCELLED) and check the number of messages sent. Send `/inbox`, `/report`, `/report 2d`, and a malformed `/report`, and
compare the content with the CLI output at the same time.

**Acceptance Scenarios**:

1. **Given** a task moves to waiting on the user for a reason that cannot be acted on in Telegram, **When** the
   notification is sent, **Then** the message states the task, the reason, what to do, and the matching CLI/TUI command.
   Each transition into waiting produces exactly one message.
2. **Given** a task ends DONE, FAILED or CANCELLED, **When** the notification is sent, **Then** exactly one message states
   the outcome, the related PR (if any), and the reason for FAILED/CANCELLED.
3. **Given** a linked chat, **When** the user sends `/inbox`, **Then** the bot returns every item that needs a person
   (questions, approvals, confirmations, and other reasons for waiting on people) across the projects the chat may view,
   with the same content as `cusr inbox` at that time. Each item states its type and whether it can be acted on right in
   Telegram or requires the CLI/TUI (FR-024). An item that can be acted on in Telegram can reopen its current action card
   with full scope and buttons, even if the original message was deleted. If there are more items than fit on one page,
   every item can still be viewed and opened through pagination.
4. **Given** a linked chat, **When** the user sends `/report` or `/report <period>` (the same `--since` syntax as the CLI),
   **Then** the bot returns a report per project, built in code, with the same content as `cusr report`. A long report is
   split into several messages, in order. If it exceeds the cap, the reply says it was cut and gives the CLI command to see
   all of it.
5. **Given** a free-text message that replies to no message and is not a command, **When** it is received, **Then** the bot
   does not guess the intent, creates no task, and only returns guidance together with the number of pending items.

### User Story 5 - Channel that survives restarts, network errors and quotas (Priority: P2)

The project owner trusts that no notification or answer is lost or handled twice, even if the daemon restarts, Telegram
has temporary errors, a quota is hit, or the bot is blocked. When the channel fails, tasks still wait with a stated reason,
and the CLI/TUI still works.

**Why this priority**: An external channel is where duplication and loss are most likely; getting this wrong breaks
invariants I03, I04 and I10.

**Independent Test**: A matrix of daemon-kill points seeded around writing a notification, sending it, recording the send
result, receiving a message, saving a received message, advancing the read position, processing an action, and editing a
message to "handled". Simulate network errors, quotas, a blocked bot, and duplicated incoming messages.

**Acceptance Scenarios**:

1. **Given** the daemon stops after receiving a batch of messages but before saving them durably, **When** it restarts,
   **Then** those messages are received again and processed exactly once. The read position advances only after the
   messages are saved.
2. **Given** a message may have been sent but no confirmation came back, **When** it is retried, **Then** the message may be
   a duplicate, but it carries the same question/request ID. Any action through any copy resolves to the same
   question/request, and no decision is doubled. A duplicate whose message reference could not be stored may keep old
   content after the item has been handled, but a reply or a button on it is still checked for validity when processed.
3. **Given** Telegram has network errors or returns quota errors, **When** sending, **Then** the send waits for the time
   Telegram asks for, or for a capped backoff. A response to a user's action does not wait behind older messages that are
   backing off. The order of still-valid notifications within the same task is kept. The task's state does not change.
4. **Given** Telegram cannot deliver a message past the send deadline, or the bot has been blocked by the user, **When** the
   deadline passes, **Then** the notification is recorded as failed with a reason, shown in `cusr status` and
   `cusr telegram status`. Questions and approval requests can still be answered via the CLI/TUI.
5. **Given** the daemon was stopped for many hours, **When** it restarts, **Then** pending notifications are sent only if they
   are still valid. Questions and requests that were already handled or are stale are not sent as if they were pending.
   Task-ending notifications that were never attempted are still sent. Notifications whose sending has already begun count
   the daemon's downtime toward the deadline (FR-002).
6. **Given** an approval request failed to send because Telegram errors exceeded the deadline, and the task is still
   waiting, **When** evidence that the send path works again appears, **Then** that request is resent in one new bounded
   round, with the same key and the same ID. Failed informational notifications are not resent. If the bot can still
   receive messages but cannot send them, or the daemon restarts, no new round is opened (FR-030).

### Edge Cases

- **EC-001**: A question is answered before its message can be sent: it is not sent as pending. If it has already been sent,
  the stored message references are edited to "answered" (FR-022).
- **EC-002**: Messages from unlinked chats, group chats, channels, or other Telegram users are ignored, with no content
  reply. Only minimal metadata (source type, time, reason) is recorded for diagnosis. A flood of stray messages does not
  fill the logs or slow down valid messages.
- **EC-003**: The user edits or deletes a reply after it has been recorded: it is not recorded again and is not undone. The
  edited message receives a reply saying that the recorded answer is unchanged, and how to proceed.
- **EC-004**: A reply with an image, file, voice note or sticker is rejected with guidance; only text is accepted. An answer
  that exceeds the length limit of `cusr answer` is rejected with a message, not silently truncated.
- **EC-005**: A question or request longer than one Telegram message is sent as a shortened copy, clearly marked, together
  with the command to see the full text. The question ID, the approval scope and the buttons are never dropped.
- **EC-006**: Two open questions share the same short ID: the answer command by ID reports the ambiguity and lists the
  options. A direct reply to a message is not affected.
- **EC-007**: Many tasks need a person at the same time (dozens of messages): messages are sent one after another within the
  quota, none are lost, and an action on one message does not affect the others.
- **EC-008**: A chat is demoted, or its project scope is narrowed, after messages were sent: an action is checked at
  processing time against the current grant, not the permissions at the time of sending.
- **EC-009**: Two daemons or other tools read the same bot's messages: the channel reports the conflict in health and does
  not process half-received messages. The daemon still holds the exclusive lock as it does today.
- **EC-010**: The machine clock jumps, or the machine sleeps for a long time: the polling schedule does not run in a
  catch-up burst, and the read position does not move backward. The link-code expiry and the send deadline use a monotonic
  clock, or are rechecked after the machine wakes.
- **EC-011**: Telegram keeps pending messages only for a limited time while the daemon is down: messages held longer than
  that are lost on Telegram's side. The user notices this when no confirmation arrives. doctor/status show the time of the
  last successful receive.
- **EC-012**: Question content or a reason contains a secret: it is masked before the notification is stored, as with every
  other output.
- **EC-013**: A stranger tries to guess a link code: codes are long enough that they cannot be guessed within the expiry,
  and the number of wrong attempts is capped. Past the cap, the code is cancelled and an admin creates a new one. The
  response does not reveal whether the code was close or had expired.
- **EC-014**: An answer sent via Telegram contains something that looks like a secret: the answer is not recorded and the
  question stays open. The reply states the reason and the two ways to continue (resend without that value, or use
  `cusr answer` on the machine). A masked copy is not recorded, because the first answer wins and cannot be edited.

## Requirements *(mandatory)*

### Functional Requirements

**Notification outbox**

- **FR-001**: Each notification MUST be created in the same transaction as the event that causes it (a question waiting for
  a person, an approval request, a confirmation request, a task waiting for the user, a task ending, a handled item that
  needs an old message updated, a response to an action from a channel). Nothing is sent before it is durably written.
- **FR-002**: Sending MUST run after the commit, at-least-once, with a timeout, a limited number of attempts and a bounded
  send deadline, with capped backoff and jitter that can be controlled in tests. Telegram's rate limits MUST be respected
  according to the wait time it returns. The send deadline MUST count from the first attempt: a notification that has never
  been attempted is still sent after a restart, and a round that has already started counts the daemon's downtime toward
  the deadline.
- **FR-003**: A send with an unknown result MUST be treated as `unknown` and resent with the same key. A duplicate message
  may occur but MUST carry the same question/request ID, and every action from a duplicate MUST resolve to the same object
  (SPEC.md §13.2).
- **FR-004**: Before a notification tied to a question/request is sent or resent, it MUST be checked that it is still valid.
  If it is stale, it is not sent as pending; if it has already been sent, the message is updated per FR-022.
- **FR-005**: Each notification MUST have a stable logical key made of its type, its scope and its cause/period (e.g. a
  question by question ID, a task ending by task, a response by request ID). The same cause MUST NOT produce two logical
  notifications. A new notification source (such as a scheduled report) MUST be addable using only a new type and key.
- **FR-006**: A response to a user's action MUST be sent before other notifications that are pending or backing off.
  Still-valid business notifications of the same task MUST be sent in creation order; a stale notification MUST be skipped
  rather than hold its place in the order; notifications of different tasks MUST NOT block each other past the send deadline.
- **FR-007**: A channel's send/receive errors MUST NOT change a task's state, MUST NOT trigger a task's retry/escalation, and
  MUST NOT block actions via CLI/TUI.

**Linking and identity**

- **FR-008**: `cusr telegram setup` MUST receive the bot token through hidden input or stdin, verify it with Telegram before
  storing it, and store it in the Cuesura data directory, outside every worktree, with file permissions that allow only the
  owner. The token MUST NOT be passed into an agent's context, environment variables or artifacts, and MUST be masked in all
  logs, artifacts and CLI output. Running setup again replaces the old token. Under
  [ADR-0005](../../docs/adr/0005-native-harness-permissions.md), the system does not promise to stop processes running under
  the same UID, including workers run with the sandbox off or with full access, from reading the token file. Setup MUST state
  this limit and how to revoke the token if it may have leaked. A new token for the same bot MUST keep the link, the read
  position and the message references. A token for a different bot MUST revoke the link and the pending code, drop unprocessed
  messages from the old bot, and start a new read position; the user MUST link again.
- **FR-009**: `cusr telegram link` MUST require `admin` permission, create a one-time code with an expiry, choose the role
  (default `operate`; `admin` only when specified explicitly) and the project scope (default: all projects of the caller).
  The role and scope MUST NOT exceed the caller's grant at the time the code is created, and they are fixed until the code
  expires, is used or is cancelled. Revoking the source CLI token MUST NOT cancel the code. Creating a new code or running
  `unlink` MUST cancel the pending code. The code MUST be long enough that it cannot be guessed within its expiry, and it is
  cancelled when wrong attempts exceed the limit. A link succeeds only when the code is sent from a private chat within its
  expiry. Changing the role or the scope MUST go through re-linking.
- **FR-010**: At any time there is only one linked chat. The channel identity MUST consist of the chat and the Telegram user;
  only messages from exactly that pair are processed. The old link MUST stay in effect until the new code is used
  successfully, and then it is replaced in the same single write. `cusr telegram unlink` MUST revoke immediately. Each link is
  a validity boundary: replies and buttons on messages from the previous link, and unprocessed incoming messages received
  under the previous link, MUST be rejected as stale even if the new link is the same chat, and MUST NOT gain the new link's
  permissions. A revoke or a link replacement commit is a boundary: operations committed before it stay in effect; uncommitted
  operations MUST be blocked if the revoke commits first. After that commit, no new send request MUST be started over the old
  link; a request already emitted before it may reach the chat late.
- **FR-011**: A linked chat MUST map to its own grant (actor, roles, projects), stored durably and effective immediately upon
  linking, with no daemon restart needed. This grant is independent of the CLI token that created the link: revoking that
  token MUST NOT revoke the link. Every action MUST be permission-checked in the application service against the current
  grant at processing time, as for a CLI token. Telegram MUST NOT default to `admin`, and MUST NOT escalate beyond its grant.
- **FR-012**: A notification MUST be sent only to a chat with `read` permission on the task's project. Action buttons MUST
  appear only when the grant is sufficient for that action.

**Receiving messages and actions**

- **FR-013**: The system MUST receive Telegram messages by actively polling at intervals, without opening a public endpoint.
  Each message or button press MUST be stored, with a dedup key derived from Telegram's update identity, before it is
  processed; the read position MUST advance only in that same durable write.
- **FR-014**: Each action from Telegram MUST have a stable request ID derived from the update identity, and MUST go through the
  same admission, dedup and service as the corresponding CLI command. Repeating it MUST return the first result.
- **FR-015**: Telegram MUST support exactly these actions: answering a question (reply to the question message, or
  `/answer <code> <text>`), approving an escalation, confirming a task against its proposed run settings, `/inbox`,
  reopening the current action card of an inbox item, `/report [period]`, and `/help`. Reopening a card MUST be built from the
  current state with full scope and buttons, MUST NOT depend on the original message, and MUST NOT create a new business
  request. Any other action MUST receive guidance; it MUST NOT guess the intent.
- **FR-016**: Buttons MUST be bound to the scope that was shown (question; approval request, revision, step, rung, policy
  hash; revision and digest of the run settings). If the scope has changed, the action MUST be rejected as stale. The
  "Confirm" button MUST appear only when a complete proposed run settings exists, and it MUST confirm the task together with
  exactly those settings as one action. If the revision or digest no longer matches, everything MUST be rejected, and no
  standalone task confirmation may be recorded. The "both or neither" guarantee MUST hold even if the process dies or a write
  fails midway; the plan MUST prove it at the transaction layer, since checking before writing is not enough.
- **FR-017**: Each action from Telegram MUST receive exactly one logical response: recorded, already handled earlier (with the
  winner), stale, missing permission, or a syntax error, with stable error codes that match the CLI.
- **FR-018**: Messages from unlinked chats or users MUST be ignored without a reply, and their content MUST NOT enter any
  agent context. The only exception is `/start <code>` in a private chat, which enters the link flow and receives one generic
  reply about the result (success, or an invalid/expired code without stating the reason).
- **FR-019**: Telegram MUST NOT offer any action that the CLI does not have. Rejecting an escalation MUST NOT be offered as an
  action; an approval message MUST state the way out if the user does not want to raise the model (cancel the task and create
  a new one).

**Content and routing**

- **FR-020**: For tasks from the CLI/assistant, questions, approval/confirmation requests and waiting-on-person notifications
  MUST go to the linked chat. Every item that needs a person MUST still appear in `cusr inbox`, whether the channel fails or is
  not configured. Routing for tasks from GitHub issues belongs to feature 005.
- **FR-021**: When `autonomous` is on, a worker's question MUST be notified only once it is waiting for a person (the decider
  did not run for the task, the decider run failed, or the decider's runs at that step are used up). The decider's answer
  MUST NOT generate a separate notification. A question that has a recorded failed decider run MUST keep waiting for a person
  across restarts and across turning `autonomous` off and on; the decider MUST NOT run again for that question, and it only
  considers questions with no recorded failed run, under the current rules. A question being handled by the decider MUST still
  appear in the inbox with a note that the decider is working on it, and the user MUST be able to answer right away; the first
  valid answer committed wins.
- **FR-022**: When a question, approval or confirmation is handled on any channel, or becomes stale, every stored Telegram
  message referencing it MUST be updated to its final state (answered / approved / confirmed / stale, with the actor, the
  channel and the time) and have its buttons removed, via the outbox. A message whose send result is `unknown` and whose
  reference could not be stored (Telegram may have received it) may not be updatable. A reply or button on any message,
  including that one, MUST still be checked for validity at processing time under FR-016, and MUST receive a final-state
  response under FR-017. Updating a message is a separate obligation for each message: if the round ends without it
  completing, it MUST be retried under FR-030 even if the question/request is already closed. If the target has been deleted
  or is determined to be unmodifiable, the outcome and its reason MUST be recorded and retrying stops, without sending a
  replacement message.
- **FR-023**: Each message MUST be self-contained: the project, the task title, the short code of the task/question, what to do,
  and the matching CLI command. Its content MUST be built by code from recorded data, without calling an LLM, and MUST be
  masked for secrets before it is stored.
- **FR-024**: The inbox MUST contain every item that needs a person among the projects the caller may view: open questions,
  approval requests, confirmation requests, and tasks waiting for a person for other reasons. Each item MUST have a type, a
  task, a reason, a next action, and state whether that action can be done in Telegram or only via CLI/TUI. Question items
  MUST keep the existing fields of `cusr inbox`. `/inbox` and `/report` MUST use the same service and the same permissions as
  `cusr inbox` and `cusr report`; their content MUST match the CLI output at the same time, differing only in presentation and
  message splitting. The inbox MUST be fully viewable through pagination, on both the CLI and Telegram, rather than just
  reporting that it was cut; on Telegram, every item that can be acted on MUST be able to open its card. A question being
  handled by the decider MUST appear with the matching note; showing an item in the inbox MUST NOT generate a push notification.
- **FR-025**: A message that exceeds the length limit MUST be shortened with a clear marker or split into several ordered
  messages, and MUST NOT lose its code, scope or buttons.

**Operations and observability**

- **FR-026**: `cusr telegram status`, `cusr status` and `cusr doctor` MUST report: whether setup has been done, which bot, the
  linked chat and its role, the time of the last successful receive, pending and failed notifications with their reasons, and
  receive conflicts (webhook, other process). Every command MUST have `--json` and exit codes that follow the existing CLI
  conventions.
- **FR-027**: `cusr inbox` and `cusr task explain` MUST show the send status of each question/request on Telegram, and the
  actor and channel of the action that won.
- **FR-028**: After a restart, the system MUST resume receiving from the stored read position, reconcile any unfinished
  notification per FR-003, not create a second receive sequence, and not resend a notification that already has a successful
  result.
- **FR-029**: When setup or linking has not been done, the system MUST behave as it did before this feature; it MUST NOT create
  notifications waiting to be sent indefinitely to a channel that does not exist.
- **FR-030**: When a notification has failed to send, the system MUST check its own send capability at a bounded cadence. Only
  evidence that the send path has worked after the failure counts as recovery; receiving messages successfully or restarting
  MUST NOT count as recovery. Each recovery MUST open at most one new bounded send round per still-valid question, approval
  request and confirmation request that failed to send, with the same key and the same ID; a restart MUST NOT reset the round
  limit. The same round rule applies to completing a final-state update (FR-022) that is still unfinished, even if the
  question/request has been closed. Failed informational notifications MUST NOT be resent. The check method and the thresholds
  are set by the plan.
- **FR-031**: After a successful link, the chat MUST receive the questions, approval requests and confirmation requests that
  are still valid within the grant's scope, one message per item under its own key. History of finished tasks MUST NOT be
  resent.
### Evidence scope and traceability

| Journey in SPEC.md | Story / requirements | Evidence required in feature 003 |
| --- | --- | --- |
| S02 Missing information, confirmation | US3.5; FR-015, FR-016 | Confirm a task from Telegram once; an old button is rejected |
| S04 Agent asks mid-way | US2; FR-001–005, FR-013–014, FR-021–022 | Answer from Telegram and from the CLI; repeated, competing and cross-channel updates, across restart |
| S05 Crash | US5; FR-002–004, FR-013, FR-028, FR-030 | Crash matrix around send, receive and processing: nothing lost, no decision duplicated |
| S10 Progress/operations | US1, US4; FR-024, FR-026–027, FR-031 | Doctor, status and inbox show the channel; `/report` matches `cusr report` |

The plan MUST clearly specify the evidence for I03, I04, I08 and I10 at the Telegram outbox and adapter layer, using
integration tests on real SQLite with crash injection, and keep the regression checks of features 001, 002 and 004.

### Key Entities *(include if feature involves data)*

Logical notifications, delivery batches, send attempts, message copies and final-state synchronization are used in their
proper sense as defined in [GLOSSARY.md](../../GLOSSARY.md).

- **Notification** (logical notification): one thing that needs to be reported; its type, logical key (FR-005), related
  project and task, the object it is attached to (question, approval, confirmation), content with secrets masked, send status,
  current delivery batch and the number of sends within that batch, and the last error.
- **Message copy**: one copy of a notification on Telegram; the message reference (present only when the send succeeded),
  the link to the notification it sent, and the final-state sync status (not needed, pending, done, cannot be updated, with a reason).
- **ChannelLink**: the linked Telegram chat and user, with their own grant (actor, roles, projects), the person who created the
  link, and the time of linking or revocation.
- **LinkCode**: a single-use link code; its role and scope are fixed at creation, with an expiry, a count of failed attempts,
  and a status (waiting, used, expired, cancelled).
- **InboundUpdate**: a message or button received from Telegram, with secrets masked, a deduplication key, the source identity,
  and the processing result (action, response, or skipped with a reason).
- **ChannelCursor**: the bot's read position in the messages; it advances only together with the write of an InboundUpdate.
- **Question / Approval / Confirmation**: inherited from the core, with the actor and channel of the winning action added.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user links the bot to a private chat in under 5 minutes by following the quickstart, using only
  `cusr telegram setup` and `cusr telegram link`, without having to find the `chat_id` themselves.
- **SC-002**: Under normal network conditions, a new question or request reaches Telegram within 1 minute after it is saved,
  and an action taken from Telegram is recorded, with a confirmation message, within 1 minute. A task can go from question to
  next run using only a phone.
- **SC-003**: Sending each reply, button press and command 2–5 times, and the same pattern of competing Telegram and CLI actions,
  produce exactly the expected logical number of answers, approvals, confirmations and attempts (0 duplicates).
- **SC-004**: At least 100 seeded, reproducible daemon interruptions distributed around the points of US5: 0 logical
  notifications lost, 0 inbound messages missed or processed twice, 0 duplicated decisions. Any duplicate message carries the same code.
- **SC-005**: 100% of the samples of stale buttons or replies (revision, rung, policy or digest changed; question already
  answered; task already ended) and of samples lacking permission are rejected with a reason. No approval or confirmation is
  recorded for a scope other than the one displayed, and no confirmation is recorded half-way (a task without its configuration),
  including samples interrupted by a process kill or a write error between the two parts of a confirmation. 100% of the replies
  and buttons from a previous link (including after re-linking the same chat) are rejected as no longer valid.
- **SC-011**: On samples of a channel that failed and then recovered, and samples of linking while work is already waiting: 100%
  of the questions, approval requests and confirmations that are still in effect appear in the chat after the channel recovers
  or linking completes. 0 notifications of information that failed earlier are resent. 0 messages are sent for tasks that ended
  before linking. 0 resend batches are opened merely because a message was received successfully or because of a restart.
- **SC-006**: 100% of the messages from unknown chats, group chats and other users are ignored: no reply, no action, and no
  characters of that content appear in the agent's saved context. The only exception is `/start <code>` in a private chat, which
  receives only a general reply about the linking result.
- **SC-007**: When Telegram is unavailable, rate-limited or blocked in a test sample, 100% of questions and requests can still be
  handled through the CLI or TUI. Status reports the correct channel error and reason, and no task changes state because of a channel error.
- **SC-008**: 100% of the questions and requests handled on another channel have every saved Telegram message that references them,
  and that can still be edited, updated to the final state once the channel is working, including samples where the channel failed
  during handling and recovered afterwards. 100% of the messages that were deleted or cannot be edited have their outcome recorded
  with a reason, kept separate from temporary errors. 100% of the replies and buttons on a message that cannot be updated (a sample
  that sends `unknown` and then resends) receive a final-state response, without recording a new action. `/inbox` (including
  samples with more than one page) and `/report` match the CLI output on every compared sample.
- **SC-009**: 0 bot tokens or secrets appear in logs, artifacts, CLI output (including `--json`) or stored message content across
  the masking test samples.
- **SC-010**: The acceptance report distinguishes simulated Telegram from smoke testing on a real bot and a real chat. Simulated
  results are not used to claim a real smoke pass.

## Assumptions

- Features 001, 002 and 004 are the foundation: inbox/answer, approve for escalation, confirm and run config, `cusr report`,
  decider, outbox, recovery, and token/grant already exist. Feature 003 adds the channel and maps it onto those services; it adds
  no new core capabilities. The user-visible behavior changes to existing parts are: expanding `cusr inbox` to every item that
  needs a person (FR-024), confirming a task and its configuration as one action (FR-016), and the decider not re-running a
  question that previously failed (FR-021). The accompanying internal changes (a hook that creates notifications inside the
  transaction, the token-masking pattern, health and doctor) are listed in the "Changes to existing parts" table of the
  data model.
- One user, one bot, one private chat (constitution, SPEC.md §2.1). Feature 005 reuses this linking and inbound path.
- Polling is the only way messages are received. With a single user, the Telegram quota is ample. Webhooks are deferred until after v1.
- The content of questions, reasons and reports is sent in full (with secrets masked) to Telegram. The user accepts that the content
  passes through Telegram's servers when linking. The setup command states this clearly. A minimal-content sending mode is deferred.
- Questions are currently free text with no list of options, so answers are given as a text reply. Choice buttons for questions are
  deferred until the core supports multiple-choice questions.
- Notifications are sent only for: questions waiting for a person, approval and confirmation requests, tasks moving to waiting on the
  user, task completion, and responses to actions. Routine progress (an attempt starting, a green gate) is not reported.
- The inbound polling interval, the link-code expiry, the send deadline and count, the backoff cap, the short-code length, and the
  message-splitting cap are set by the plan.
- A test Telegram bot and a private chat are needed for smoke testing. If they are missing, the corresponding real criteria are
  recorded as not yet checked.
