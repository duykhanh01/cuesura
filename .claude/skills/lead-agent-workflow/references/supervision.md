# Supervision

How to wait, how to tell a stuck worker from a slow one, what each CI verdict asks of you, and how
to recover. The tool-specific commands are in `tools.md`.

## Waiting

Pick the first wake your tool offers, and record it in the ledger's `Wake` column:

1. **The tool's completion event** for a worker you dispatched.
2. **The tool's PR watcher**, where it has one.
3. **A background script** whose exit wakes you: `scripts/pr-ci.sh <pr> --wait [minutes]`.
4. **A timed check-in** as the fallback, set to the pace of the work: about 10 minutes for CI, 20
   to 60 for a coder.

One event or one background script replaces many check-ins, and every wake re-reads your whole
context. If the tool forbids a kind of waiting (some forbid sleep loops and polling), its rule
wins; use the wake it provides.

Keep a timed fallback behind every event-based wake when the tool allows one. Completion notices
get lost when the lead is archived or the daemon restarts, and can arrive twice.

## Each wake

Reconcile before you act: list every live worker and take a verdict on every open PR, then compare
with the ledger. A notice tells you something changed, and the ground tells you what.

When a wake needs no action, end the turn without a message.

## Slow, idle, stuck, dead

| What you see | What it is | What to do |
| --- | --- | --- |
| Status running, recent activity or commits | working | wait |
| Turn ended with "waiting for tests" or similar, no PR and no blocker | idle | resume it: "continue, and report in the usual shape" |
| Status idle, and background work it started is gone | idle with dead background work | resume it and say what died |
| Status running, but no activity and no commit for 30 minutes | probably stuck | check status and activity together, then nudge |
| Two nudges without progress | stuck | restart the session on the same worktree; brief the new session from the report file |
| Agent gone, worktree gone | dead | set the task back to `queued` and clear its owner |

- Call a worker stuck only when its self-reported status and its real activity agree. One stale
  signal alone is often a reporting gap.
- A restart keeps the worktree and the branch. Delete a worktree only when its work is merged or
  pushed; unpushed work exists nowhere else.
- A worker that asks a question is waiting on you. Answer it, or rule on it, in the same wake.

## CI verdicts (GitHub)

`scripts/pr-ci.sh <pr> [--wait [minutes]]` prints one verdict for the head commit and exits 0 for
GREEN or MERGED, 1 for RED, 2 for NO_RUN, DIRTY, DRAFT or CLOSED, 3 when still PENDING at the
timeout.

| Verdict | Action |
| --- | --- |
| GREEN | run the rest of the merge gate |
| RED | have the coder read the failed job. A known flaky test gets one rerun of the failed jobs (`gh run rerun <id> --failed`); a second failure is real |
| PENDING | wait |
| NO_RUN | no workflow ran for this head. Toggle the PR: `gh pr ready N --undo && gh pr ready N` |
| DIRTY | conflict. The coder rebases (`review.md`, "After a conflict"); GitHub runs no `pull_request` workflow on a conflicted PR |
| DRAFT | finish review, then `gh pr ready N` |
| MERGED / CLOSED | update the ledger; a CLOSED PR you did not close needs a look before anything else |

- Judge CI only on the head commit. A green run on an older commit proves nothing about the head.
- A check from outside the repo's own workflows (a third-party status) is something to report with
  its URL. Fixing it is outside the task.
- **Behind the base:** before merging a PR that is behind, list what reached the base since the
  PR's last green run and compare with the PR's files:

  ```sh
  git fetch origin
  git diff --name-only <sha-of-last-green-run>..origin/<base> | sort > /tmp/base.txt
  gh pr view N --json files --jq '.files[].path' | sort > /tmp/pr.txt
  comm -12 /tmp/base.txt /tmp/pr.txt
  ```

  Any overlap means: update the branch and wait for green again.
- On another git host, take the same verdicts from its CLI or API and keep the same actions.

## Quota

- If workers share your quota, find the reset time (the vendor's usage page or CLI) and set a
  check-in just after it.
- A worker on another vendor that runs out often comes back within a few minutes. Retry it then.
  Meanwhile keep coding the independent tasks and hold their PRs for review.

## Your own context

Your context is the most expensive in the run, because every wake re-reads it.

- Past about half of your window, write the ledger, write a handoff (`contracts.md`), and continue
  in a fresh session that starts from the ledger.
- After a compaction or a restart, rebuild from the ground: read the ledger, `git log` on the open
  branches, the list of live agents, the open PRs. Tasks marked `merged` or listed under Done stay
  done; resume each other task from its recorded state.

## When the user is away

- With authority, decide and record a ruling; the user reads the rulings in your report and reworks
  what you got wrong.
- A question only the user can answer parks that one task as `blocked`. The other tasks keep
  moving.
- Before a long wait on the user, release what can be released: stop watchers on parked PRs, and
  say in the ledger what resumes when the answer comes.
