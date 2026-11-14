# Pitfalls

Traps that no workflow step already covers. Each entry is the rule first, then one line of what
happened.

Before adding an entry, try the cheaper forms in SKILL.md step 7: fix the cause, add a check, give
the reviewer a rule. When an entry becomes a workflow rule or a tool card line, delete it here.

## Judgement

- **Put the mechanics in scripts and leave the judgement to the lead.** A deterministic runner
  delivered less than one lead agent with thin scripts.
- **Reuse what exists, and add a strict rule only after a real incident.** Designs that piled on
  human-only commands and safety layers cost more than the failures they prevented.

## GitHub

- **Let a push settle before `gh pr ready`.** A push and a ready at the same moment left no CI at
  all: the push run skipped the draft, and concurrency cancelled the ready run. The verdict is
  NO_RUN.
- **Check the PR's state before retrying a merge.** `gh pr merge` failed on a local ref lock
  although the PR had merged.
- **`--admin` merges a branch that is behind the base without updating it,** so run the
  behind-the-base check in `supervision.md` first.

## Ownership

- **Another system's branches and other people's PRs stay theirs.** Port the work to your own
  branch, keep the original commits and credit, and link the source PR.
- **Closing or replacing an issue can leave the spec stale.** Have a cheap agent send a docs PR, or
  a later review will flag it.
