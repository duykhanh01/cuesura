---
name: lead-agent-workflow
description: >-
  Lead coding work through worker agents from a request to merged PRs: build a task graph, dispatch
  coders and reviewers, run the review loop, gate on CI, merge when allowed, and keep the session
  alive and cheap. Works with any orchestration tool (Paseo, T3 Code, Claude Code, others). Use
  only when the user explicitly asks you to orchestrate, coordinate or dispatch other agents to do
  the work, e.g. "orchestrate agents to fix these issues", "dispatch coders and reviewers",
  "use Paseo to run this". Do not use when the user asks you to do the work yourself, or for a
  single helper subagent you start on your own initiative.
---

# Lead agent workflow

Lead the run: own scope, authority, task graph, dispatch, triage and merges. Coders implement;
reviewers independently check; an optional advisor proposes solutions or decides within a recorded
delegation. Talk in the user's language and carry language requirements into briefs.

Use one coder and a brief for a single small, low-risk task; verify its output and CI without a
full ledger. Use the durable contracts below for multiple tasks or consequential work. Risk follows
impact: a configuration change can be high risk. Tasks that cannot land green independently share
an explicit integration branch and a final whole-branch review.

## Intake and preflight

Resolve this skill's installed directory from the `SKILL.md` location and use absolute paths for
its helpers, regardless of the worker's current directory. In command examples, `/absolute/skill-dir`
means that installed directory, not the target repository root.

Read the request, repository rules and existing grants first. Record goal/source, `merge` or
`stop-at-ready`, permitted providers/profiles/models/effort, escalation authority and the total
agent limit. Ask once, in one batch, only for missing choices that affect execution. Preserve prior
authorization; ask about stronger-model escalation if it has not been settled.

If no advisor choice exists, ask: delegated decisions within a specified scope, advice only, or no
advisor. Record scope, exclusions and revocation rules with the choice. Decision authority does not
expand merge, deploy, access or product scope. Read [advisor.md](references/advisor.md) when using one.

Preflight the actual repo/remote/base, CI and expected checks, draft/docs-only policy, PR templates
and workspace lifecycle. Inspect existing configuration; investigate runners/access only when
needed or contradictory. Missing setup grants no infrastructure authority. When new-repo setup is
in scope: land CI on base, enable required checks, then start dependent PRs.

## Plan and dispatch

1. Create the run outside disposable worktrees using [contracts.md](references/contracts.md).
   Reuse an existing plan, or let the advisor propose one when planning is wanted; do not add a
   separate mandatory planner.
2. Give each parent an overall goal and integration criteria. Give each child a stable ID (`T4.1`),
   owner, risk, owned files/interfaces, criteria source, dependencies and verifiable output. The
   coder owns its implementation checklist; do not dispatch an agent per code/test/lint step.
3. Check coverage and overlaps in the code. Assign a shared interface to one owner or order its
   consumers. Prefer independently mergeable children. For an integration branch, record its target
   and the verified integrated commit that satisfies each dependency.
4. Before dispatch, verify dependencies, scope size, ownership, base, brief revision and allowed
   profile. Prioritize unblocking, fixes and review over new work. The concurrency limit includes
   coders, reviewers, advisors and authorized descendants; spare slots need not be filled.
5. Read the current [tool card](references/tools.md). Use the harness's workspace and dispatch
   mechanisms. Resume context that is still useful; start unrelated work separately. Validate
   recipient task/role against its ID in Owner before sending; never probe a real worker with test
   messages. Record branch, owner and a supported wake before waiting.

A mid-flight split requires the coder to stop at a named checkpoint, preserve commits and unfinished
work, and hand ownership to the lead before children start. The parent then tracks integration;
it is not another concurrent implementation owner.

## Progress and reports

The implementation phases are `queued → coding → reported → reviewing ↔ fixing → ready`.
Blocking is an overlay: keep Phase, record reason/evidence, unblock condition and exact resume step
in Block/Next. Clear Block when resolved and continue that phase, rather than resetting to queued.

- A coder's DONE completes its assigned turn, usually a reported PR; verify PR, full head SHA,
  owned scope, report revision and meaningful evidence. Old revisions cannot establish completion
  against changed criteria. DONE_WITH_CONCERNS needs triage; NEEDS_CONTEXT needs context; BLOCKED
  needs a changed condition before retrying. A missing PR without a blocker is unfinished work.
- Reviewer and advisor turns finish with accepted reports, without needing PRs. Distinguish terminal
  outcomes `merged`, `accepted`, `handed-off`, `cancelled`, `superseded`. A handed-off PR does not
  satisfy a dependency requiring merge. A parent finishes after its children and integration
  criteria are verified.
- Update canonical briefs for changes to goal/scope/criteria, increment revision, and send a delta.
  Before re-check, all queued requests affecting the result must be resolved and pushes settled.
  Use [templates](references/contracts.md#briefs-and-revisions), not repeated prompt histories.

## Review, ready and merge

Use no reviewer only for genuinely low-risk work unless the user/repo requires one; ordinary logic
gets one independent reviewer, consequential state/security/concurrency work the strongest allowed
reviewer. Prefer another model family where authorized. Workers start no reviewers themselves.
Follow [review.md](references/review.md): stable findings, bounded scope, same reviewer by default,
evidence-based replacement, no round/line-count escape gate.

Before ready: review complete, blockers resolved, evidence covers the diff, pushes settled. Keep
PRs draft through review where required. Where CI skips drafts, mark ready before waiting for green;
do not create a circular gate. Respect the repo/user's draft policy elsewhere.

Before merge, require all of:

- the grant permits merge, findings are resolved and the report covers the exact full head;
- current-head CI is GREEN through [scripts/pr-ci.sh](scripts/pr-ci.sh), including external checks
  and expected checks from a reviewed policy; merge bound to that SHA (`gh pr merge --match-head-commit`);
- no conflict; base changes since the verified base checkpoint have been assessed for shared files
  and interfaces, updating/revalidating the branch when needed;
- no unauthorized weakening of tests or gates. An approved snapshot behavior update is distinct
  from hiding a regression.

Merge one PR at a time in dependency order. Under stop-at-ready, hand it back ready. After merge,
fetch the base without pulling into another worker's shared checkout, update the ledger, recompute
the frontier and take fresh verdicts on other open PRs. After an ambiguous merge error, read actual
PR state before retrying. See [supervision.md](references/supervision.md) for CI and recovery.

## Supervise and close

On wake, read the ledger and reconcile workers, Git and open PRs through the harness's permitted
mechanisms. A notice is a signal, not a verdict. Advance every step whose evidence is already
available until genuinely waiting; do not artificially limit a wake to one state transition. Save
the ledger and the supported continuation before waiting. Do not invent polling or a guaranteed
future notice. Keep independent tasks moving while one is blocked.

Report outcomes/PRs, active decisions and their costs, deferred findings and unverified areas. Lead
marks terminal outcomes; [scripts/task.sh](scripts/task.sh) mechanically creates/checks briefs and
archives completed tasks by parent. It never dispatches, chooses models or declares work done.
Preserve active decisions and stable report links. Clean up only when no worker needs the workspace
and commits, untracked files and unfinished work are preserved; pushed is insufficient by itself.
Cancel obsolete agents/wakes/watchers through the harness, and leave nothing running unaccounted.

Learn in this order: fix the cause, add a behavior check, give the reviewer a rule, then add a
nonduplicated lesson to [pitfalls.md](references/pitfalls.md). New tool knowledge belongs in its card.
Trust adequate evidence; repeat checks only for gaps or contradictions. Follow repo checks by change
type, including docs-only exceptions and full-suite-on-CI policies.

## Decisions and defaults

Within authority, decide and record a lead ruling (question, conclusion, evidence, cost if wrong).
Route existing decisions first, then substantive questions within the advisor's grant; the advisor
owns its decision record and the lead retains its reference. Ask the user for unclear goals,
unauthorized scope/model/access, destructive actions or weakening checks. Block only affected work.

Defaults, overridden by user/repo rules: two concurrent agents, at most four without a new grant;
strong coder at medium effort; independent reviewer at high effort by risk; isolated workspace per
implementation task. Discover available model names/profiles; never silently substitute a backend.
Use the PR-writing and review-comment skills when available. Defer findings with a tracking location
and revisit condition; open issues only when authorized.

Read [contracts.md](references/contracts.md) for canonical ledger/reports, revisions and archive,
[tools.md](references/tools.md) before dispatch, [review.md](references/review.md) for findings,
[supervision.md](references/supervision.md) for waits/recovery, and
[advisor.md](references/advisor.md) for delegated decisions.
