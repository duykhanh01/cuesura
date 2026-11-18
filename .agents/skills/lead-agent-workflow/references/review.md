# Review and re-check

The first reviewer is independent of the coder's reasoning. Supply source requirements, PR/full
head/base and owned scope; do not prefill the review with the coder's justification. Use the repo's
review skill and comment format when available. Only authorize reviewer subagents explicitly,
within the run's total limit and harness rules; otherwise review axes sequentially.

## Triage

After the complete review, settle every stable finding ID with evidence and a route:

| Route | Evidence and result |
| --- | --- |
| Fix | Real defect within the PR's responsibility; coder fixes and reviewer re-checks. |
| Fix without re-check | Unambiguous low-impact correction with sufficient automated evidence; record why. |
| Defer | Outside scope or explicitly accepted nonblocking cost; record reason, tracking link and revisit condition. |
| Reject | Wrong or unnecessary for the goal; record evidence and ruling. |

A finding names file/line, quoted code, a concrete failing scenario, impact and suggested fix. Ask
for missing evidence rather than accepting a label. A new serious defect attributable to the PR
must be triaged even outside the latest edited lines. Never demote a blocker merely to finish.
Existing unrelated defects need not expand this task. Tests/gates must not be weakened without
user authority; updating an expected snapshot for approved behavior is not automatically weakening.

## Fix rounds

Resume the same coder and reviewer by default; useful context avoids rediscovering settled work.
Re-check open findings and related impact of the fix, not new product features, speculative
hardening or unrelated refactors. Settled points reopen only for new evidence or a change that
invalidates the decision. Coder objections with tests/paths are valid; lead rules after the exchange.

Before re-check, resolve queued requests affecting the result, finish pushes and name an exact
full SHA, prior reviewed SHA and fix range. Use the follow-up template. Record each finding's
route/evidence and reviewed SHA in the reviewer report, with current status first. A review of an
old revision/head cannot close newly changed criteria without assessing their impact.

There is no round or line-count exemption. Two rounds without progress signal diagnosis: group by
root decision, clarify the brief or ask the advisor within its authority. Missing access or quota
blocks the current phase with a resume condition. Escalate models only within the grant.

Replace a reviewer when unavailable, unable to resume, context no longer useful, demonstrably
stuck, or when a foundational change calls for an independent view. A replacement can continue a
narrow re-check using open findings, settled decisions and fix range; new agent does not mean new
whole-diff review. A fresh independent review is a lead judgment based on changed assumptions and
impact, never a formula about diff size. Supply settled findings/rulings, but not the coder's
reasoning. Record the reason for replacement. Higher-priority harness restrictions can require a
new delegate for re-check; preserve the narrow scope and records instead of claiming an override.

## Evidence and seams

High-risk changes require behavioral evidence: a reproducing test or verification in a real
environment, with command, result, commit and unverified limits. Diff statistics do not prove tests.
For privacy/security, identify the relevant input class that can evade the guard, verify that class
and ask the coder to try to break it. Bound the input classes by the changed behavior and threat model.
Trust adequate checks; repeat them for an actual gap, contradiction or changed code.

After conflicts, tell the coder which base change matters and the intended combined behavior.
Compare before/after series (`git range-diff`); reviewer checks the resolution where features meet.
Follow repo rules for rebases and force-with-lease. On an integration branch, review tasks by risk
and review the whole integrated diff after the last task, with findings triaged by the same rules.
Do not replace convergence with a fixed number of final rounds.
