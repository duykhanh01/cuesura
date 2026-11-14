# Contracts

The fixed shapes that pass between you and the workers. Write the prose in your own words; keep the
fields. Leave out a field that does not apply, since an empty section is noise the worker still
reads. If your tool builds its own brief, put these points into it.

## Run directory

One directory per run, outside the working trees so every worker can reach it:

```text
~/.agents/orchestrate/runs/<repo>-<YYYYMMDD>-<slug>/
  ledger.md
  briefs/<task>.md        only when a brief is too long to send inline
  reports/<task>.md       written by the worker; fix rounds append to it
  notes/                  scout and exploration notes that coders read
```

If workers cannot write there, use `$(git rev-parse --git-common-dir)/orchestrate/<run>/`, which
all worktrees of the repo share and git never cleans.

## Ledger

```markdown
# Ledger — <goal in one line> — <date>

Source: <tickets | plan path | user's list>
Grant: merge | stop-at-ready · may decide: <reviewer, models, order, escalation>
Workers: coders=<n> · coder=<model/effort> · reviewer=<model/effort> · tool=<name>

| Task | State | Owner | Branch / PR | Round | Wake | Next |
| --- | --- | --- | --- | --- | --- | --- |
| logs-follow-stop | reviewing | coder a1f3 · reviewer 9c2e | fix/logs-follow-stop · #291 | 1/3 | reviewer finish notice | triage findings |

## Rulings
- R1: <what you decided> — <why> — <cost if wrong>

## Deferred
- <task>: <finding> → PR description | issue #

## Done
- <task>: merged #290 (a1b2c3d)
```

- `Owner` holds whatever your tool needs to reach the same agent again (agent id, thread id).
- `Wake` names the thing that will wake you for that task: a finish notice, a PR watch, a
  background script, a timed check-in.
- A finished task collapses to one line under Done.
- The first line identifies the run. A ledger that names another goal belongs to another run; leave
  it alone.

## Coder brief

Many workers start with none of your history, so the first brief stands on its own:

- **Goal** in the user's words, with a link to the ticket. Add constraints; keep the goal the size
  the user set.
- **Acceptance criteria:** the checkable conditions that mean done.
- **Out of scope:** what to leave alone, and which PR owns any shared piece.
- **Where to work:** the worktree, the branch and the base.
- **Premises as claims to check:** "I believe X; verify it, and tell me before building on it if it
  is wrong."
- **Pointers:** ticket, spec section, notes file, earlier commits. Link them; the worker reads what
  it needs.
- **Done means:** a PR described with the PR-writing skill, targeted tests passing, the latest base
  merged into the branch, and the report contract below.
- **House rules:** make the smallest change that meets the criteria; start no subagents and no
  reviewers; leave the full test suite to CI.

Aim for this density. The structure is yours to choose.

```text
Fix #42 (https://github.com/o/r/issues/42): `logs --follow` should stop when the task needs a
human. Done = a test that follows a task into needs_input passes, and the command exits 0 there.
Work in ../r.worktrees/fix/logs-follow-stop (from origin/main). I believe the stop signal already
exists as a `needs_input` event; check before adding one. #57 owns the wake hook, so leave
src/hooks/ alone. Draft PR following the repo's PR template (or a PR-writing skill such as `write-pr`, if installed); merge origin/main in before you report. Write the full
report to <run>/reports/logs-follow-stop.md and reply in the usual short shape.
```

## Report

The worker writes the full report to `reports/<task>.md` and replies with at most 15 lines:

- **Status:** `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT` or `BLOCKED`.
- The PR URL and head SHA, or what blocks it.
- The change in behaviour, in a sentence or two.
- **Evidence:** what the worker observed itself in this session, with the command and its result.
  The strongest form is a reproduction that failed before the change and passes after it. For UI or
  runtime behaviour, running the thing and looking beats a green mocked test.
- What was not verified, and any concern or open question.

One shape makes many reports cheap to scan. The report file is also the memory a replacement
worker starts from.

## Reviewer brief and findings

The brief: use the review skill on PR #N; the ticket or spec it implements; the owner of any shared
concept; review only, no edits. Add nothing the reviewer can discover on its own, and say nothing
about what to ignore. If the reviewer's harness has no review skill, name its built-in review.

Each finding comes back as:

```text
F1 [BLOCKING | NOT BLOCKING] <file>:<line> — "<the line of code it is about>"
   Fails when: <a concrete scenario>. Fix: <suggestion>.
```

Zero findings is a valid review. Stable ids let later rounds refer to the same finding.

## Follow-ups

Send the delta, never the history.

- **Next task in a chain:** the new ticket, the new branch, and any premise that changed.
- **Findings to the coder:** the findings verbatim, marked with your triage (fix, or fix without
  re-check). Ask the coder to check each against the code first, to push back with evidence where
  the finding is wrong, and to reply with the commit SHA and one line per finding.
- **Re-check to the reviewer:** what changed for each finding it raised, the fix range, and one
  question: did the fix break anything in the lines it touched?
- **Rebase:** which merge caused the conflict and which side wins where they overlap. The coder
  pushes with `--force-with-lease`.

## Scout or investigation

- The scout runs `date` first and gets a minimum as well as a maximum duration. Scouts given only a
  time box have stopped after about three minutes.
- Findings come with a reproduction: a failing test in a detached worktree, in files named
  `scratch-*` that are deleted afterwards.
- Ask for ranked findings, each with its evidence, plus the areas it did not cover. Resume the same
  scout for those areas.
- Notes go to `notes/` in the run directory, so coders read them and skip the exploration.

## Handoff

For a replacement worker, or for a new lead session taking over yours:

- two or three pointers that matter most: the ledger, the report file, the PR;
- what is decided (the rulings) and what is open;
- the one next step.

Link what already exists in the ledger, the reports and the commits. Whoever picks it up checks the
current state on the ground before acting on it.
