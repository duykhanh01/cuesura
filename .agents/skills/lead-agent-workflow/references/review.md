# The review loop

```text
reviewer: review the PR
  no findings                 -> ready
  findings -> lead triages
    fix                       -> same coder fixes -> same reviewer re-checks -> repeat
    fix without re-check      -> same coder fixes -> ready
    defer / reject            -> ledger -> ready
```

## Triage

Wait until the reviewer has finished, then judge every finding in one pass. Triage as findings
trickle in and some get forgotten.

Judge each finding on its own evidence:

- A finding needs the line of code it is about and a concrete failing scenario. One that has
  neither goes back to the reviewer once for evidence, and is rejected if none comes.
- Read only the lines in question to settle a doubt.
- A reviewer's severity label is advice. The route is your call.

| Route | When | What happens |
| --- | --- | --- |
| **Fix** | A real defect this change introduced, in the intended case. | Coder fixes; reviewer re-checks. A defect this change caused is never deferred. |
| **Fix without re-check** | Real, small, and the fix is unambiguous: it adds no public surface and guards no state nobody demonstrated. | Coder fixes; CI is the check. |
| **Defer** | Real, but outside this change: another path, a rare case, a small cost, code that was already there. | One checklist line in the PR description, and a line under Deferred in the ledger. |
| **Reject** | Wrong, or it asks for something the goal does not need. | A ruling in the ledger with the reason. |

Anything that weakens a test or a CI gate goes to the user, whatever the route: removed or skipped
tests, loosened assertions, raised thresholds, regenerated snapshots.

## Fix rounds

A round is one fix by the coder plus one re-check by the reviewer.

- **Rounds 1–3: the same coder and the same reviewer,** both resumed. The coder knows the task and
  its own reasons; the reviewer knows its own findings.
- **The re-check is narrow.** For each open finding the reviewer answers ADDRESSED or NOT
  ADDRESSED, and it looks for breakage only in the lines the fix touched. Anything new outside
  those lines goes under Deferred and never extends the loop.
- **The coder may disagree.** A pushback with evidence (file and line, a test, command output) is a
  valid answer. You settle the dispute after one exchange; the same argument does not go round
  twice.
- **Keep the PR the size of the goal.** Take the fix that deletes or narrows code over a new guard,
  helper or option. If review grew the diff, cut before the next round.
- After each round, write the ledger: round number, what was addressed, what is open.

The cap is three rounds. A high-risk task may run rounds 4 and 5, on a stronger model.

## When the loop does not converge

If the same finding survives two rounds, or round three ends with a blocker open, find the cause
before sending another round:

- **One root decision keeps producing findings.** Group the findings by the decision they come
  from, settle that decision, then fix.
- **The brief or the spec is unclear,** or coder and reviewer read it differently. Settle it with a
  ruling, or re-brief.
- **The reviewer raises new nits each round.** Look at what truly blocks, defer the rest, move on.
- **The coder cannot see its own problem.** On a high-risk task, and if the user allows
  escalation, rounds 4 and 5 go to a stronger model: change the model on the same agent where the
  tool can, otherwise start a new coder that reads the report file first. On other tasks, rule at
  the cap.
- **The cause is outside the code:** a broken environment or toolchain, missing access, flaky
  infrastructure, or a decision only the user can make. Mark the task `blocked`, leave the PR open,
  record the evidence, and carry on with the other tasks.

At the cap, stop dispatching and rule on each open finding yourself:

- the reviewer is wrong, or the point is contestable: reject it, with the reason;
- real, and nothing downstream builds on it: defer it;
- real and load-bearing: rule on the smallest change that unblocks dependent work, or mark the task
  `blocked`.

Rule on findings only at triage or at the cap. Dropping one mid-loop to end the loop sooner is a
silent discard.

## Same agent or a new one

Resume the same agent when the work continues what it already knows: a coder fixing its own code, a
reviewer checking its own findings. Start a new one when:

1. **The coder is stuck:** three rounds have not cleared the blockers.
2. **The fix changed the approach:** most of the PR was rewritten, or a rebase resolved conflicts
   in a high-risk area. The old reviewer's picture is stale; give the result a first review again.
3. **The old context is a burden:** it is very large, it went down a wrong path, or the tool cannot
   resume.

The first review of any PR always goes to an agent that has seen none of the coder's reasoning.

## After a conflict

- Tell the coder which merge caused the conflict and which side wins. It rebases, compares the
  series before and after with `git range-diff`, and pushes with `--force-with-lease`.
- If the resolution combined two features in shared code, have the reviewer check the resolution
  alone before the PR merges. Seam bugs appear only there.
- If the base has moved so far that the PR no longer fits, choose before any rebase: update it,
  rework it, or recommend closing it. Closing a PR needs the user's word.

## Integration branch

When tasks share one integration branch, each task still gets its own review by risk. After the
last task lands on the branch:

- one whole-branch review on the strongest model, pointed at the Deferred list in the ledger;
- one fix agent that takes the complete findings list;
- one narrow re-check of that fix. What remains after it goes to the user with the report.
