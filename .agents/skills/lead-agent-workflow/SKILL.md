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

You are the lead. Workers write the code and the reviews; you decide who does what, move each task
from one state to the next, and make the calls. The workflow below is the spine. Use judgement
inside each step, and keep the steps and their gates.

Talk to the user in their language. This skill is in English because English costs fewer tokens.

## Five rules everything else follows from

1. **The ledger is your memory.** Everything you know about the run lives in one file. After
   compaction or a crash, trust the ledger and git over what you remember. A lead that lost its
   place has re-dispatched whole finished task chains.
2. **Contracts travel as files.** Briefs, reports and findings have fixed shapes
   (`references/contracts.md`) and move as file paths and links. Whatever you paste into a prompt,
   and whatever a worker prints back, you re-read on every later turn.
3. **Evidence over testimony.** A worker's report is a claim. A task changes state only when a
   condition you can check on the ground holds: the PR exists, the head SHA matches, CI is green on
   that SHA.
4. **You write no product code.** A fix you make yourself skips review and fills your context.
   Send it to the worker that owns the task.
5. **Every turn ends with a wake.** Before you end a turn, the ledger names what will wake you for
   each live task. With no wake, you stay in the turn.

The tool you orchestrate with decides the mechanics: how to spawn, resume, wait and watch a PR.
Read its card in `references/tools.md` before the first dispatch. This skill decides the policy:
what to dispatch, which gates apply, how findings are settled.

## Size the work first

Running several agents costs many times the tokens of doing the work in one session, so match the
machinery to the job:

- **One small, low-risk task:** one coder, one brief, no reviewer and no ledger. Still check the PR
  and CI yourself before calling it done.
- **Two or more tasks, or any task above low risk:** the full workflow.
- **Tasks that cannot land green one by one** (a wide refactor, an expand–contract migration): the
  full workflow on one integration branch, with one whole-branch review at the end.

## Task states

```text
queued -> coding -> reported -> reviewing <-> fixing -> ready -> merged
any state -> blocked (reason and evidence in the ledger) -> queued once unblocked
```

| Move | Holds when |
| --- | --- |
| queued -> coding | every blocker is merged, the task has one owner, a wake is recorded |
| coding -> reported | the PR exists and its head SHA equals the one the report names |
| reported -> reviewing | a reviewer is dispatched; low-risk tasks skip to `ready` |
| reviewing/fixing -> ready | no blocking finding is open (`references/review.md`) |
| ready -> merged | the merge gate in step 6 passes and the grant allows merging |

## Workflow

### 1. Intake

Open a run directory and its ledger (`references/contracts.md`), then record:

- the goal in the user's words, and where the work comes from (tickets, a plan, a list);
- the **grant**: `merge` or `stop-at-ready`, and what you may decide alone (reviewer and model
  choice, task order, model escalation);
- whether the user wants a planning pass, how many coders may run at once, which models.

Ask only what would change what you do, in one batch, with the harness's question tool. Take the
rest from "Defaults" and say what you chose.

*Done when the ledger header holds the goal, the source, the grant and the worker settings.*

### 2. Task graph

The graph comes from one of three places:

- **It already exists** (tickets with blockers, a plan with tasks): use it.
- **The user wants planning:** dispatch a planner agent and tell it to use the planning skill that
  is installed. With none installed, offer to install one (`to-tickets` from `mattpocock/skills`
  fits one-PR-per-task work). Show the result to a user who is present; with authority, proceed.
- **The user wants no planning:** take the tasks as given.

Then make it executable:

- Each task gets a name, acceptance criteria, its blockers, a risk level (low, normal, high) and
  the files or area it owns. One task owns each file.
- For every pair of tasks that share a file or an interface, either order them or name the one PR
  that owns the shared piece, and record that as a ruling. Check dependencies in the code; a name
  or a label is a guess.
- Put prefactoring first. Fold several small edits of the same shape into one task.
- Keep any order the user agreed to.

*Done when every task has criteria, blockers, risk and an owned area, and every overlap has a
ruling.*

### 3. Dispatch

The **frontier** is the set of queued tasks whose blockers are all merged. Dispatch from it, up to
the parallel limit:

- One worktree per task, cut from the latest base the way the repo's own rules say.
- Resume the coder that just finished a neighbouring task in the same area. Start a new agent for
  unrelated work.
- Write the brief per `references/contracts.md` and name the model explicitly.
- Record the agent id, branch and wake in the ledger before the turn ends.

*Done when every dispatched task is `coding` in the ledger with an owner and a wake.*

### 4. Report

Each worker ends with one of four statuses:

- **DONE:** verify it. The PR exists, its head SHA is the reported one, the diff stays inside the
  task's owned area, the report file holds the evidence. Then move to `reported`.
- **DONE_WITH_CONCERNS:** read the concerns. Settle those about correctness or scope before review.
- **NEEDS_CONTEXT:** supply it and resume the same worker.
- **BLOCKED:** change something before retrying: more context, a stronger model, a smaller task, or
  a ruling that corrects the plan. A report with neither a PR nor a blocker means the worker stopped
  early; resume it.

If a worker says one of your premises is wrong, re-plan before merging anything related.

*Done when the task is `reported`, `queued` again with a change, or `blocked` with a reason.*

### 5. Review

Risk decides the review:

- **Low** (docs, text, config values, mechanical edits): none. The task is `ready`.
- **Normal** (ordinary logic): one reviewer.
- **High** (state, concurrency, persistence, security, migrations): the strongest reviewer you
  have.

When a review comes back, follow `references/review.md`: triage, fix rounds, re-checks, the round
cap, and what to do when the loop does not converge.

*Done when no blocking finding is open and every other finding is fixed, deferred or rejected with
a ruling.*

### 6. Merge

The merge gate, all on the head commit:

- no blocking finding is open, and the report's evidence covers the diff;
- CI is green (`scripts/pr-ci.sh <pr>` gives one verdict on GitHub);
- the PR has no conflict, and no commit that reached the base after the last green run touches the
  PR's files. If one does, update the branch and wait for green again;
- nothing in the PR weakens a test or a CI gate without the user's word.

With grant `merge`, you alone merge, one PR at a time, in dependency order. With `stop-at-ready`,
leave the PR ready and say so. After each merge: update the local base, recompute the frontier,
dispatch what opened up, and take a fresh verdict on every other open PR.

*Done when the task is `merged`, or `ready` under `stop-at-ready`.*

### 7. Close

- **Report:** each task by name with its PR and state; every ruling with what it costs if wrong;
  deferred findings; what was left unverified.
- **Clean up:** agents, scheduled wakes, and worktrees whose work is merged or pushed.
- **Learn:** for each mistake worth preventing, pick the cheapest form that stops the repeat, in
  this order: fix the cause in the code, add an automated check, add a rule the reviewer enforces,
  add one line to `references/pitfalls.md`. A tool that has no card yet gets one in
  `references/tools.md`.

*Done when the user has the report and nothing is left running.*

## The lead loop

On every wake:

1. Read the ledger.
2. Reconcile it with the ground: the status of every live worker, the verdict of every open PR.
   Completion notices get lost and get repeated, so check all of them, not only the one that woke
   you.
3. Move each task at most one state, by the table above.
4. Write the ledger, including the next wake for each live task.
5. If nothing changed, end the turn without a message.

Waiting, stuck workers, CI verdicts, quota and handing over your own context:
`references/supervision.md`.

## Deciding alone

A running plan does not wait on a person. When you have authority, decide, and write the decision
in the ledger as `Ruling: <what> — <why> — <cost if wrong>`. A question that has a recommended
answer is a ruling.

Ask the user, with the harness's question tool, only for:

- an action that cannot be undone (deleting data, force-pushing a shared branch);
- anything security-sensitive;
- anything outside the grant (other people's branches or PRs, production, a change of scope);
- weakening a test or a CI gate: removing or skipping tests, raising thresholds, regenerating
  snapshots;
- a goal so unclear that the answer changes the result, or a plan so broken that every path is a
  guess.

A task that waits on the user parks as `blocked` while the others keep moving. With no answer, take
the safe path: leave the PR open and put the question first in your report.

## Choosing workers

- **Coder:** a strong model at medium effort for features and bugs; a cheap one for docs, spec
  updates and mechanical edits. Cheap models take two to three times the turns on multi-step work,
  so price a task by turns, not by token rate.
- **Reviewer:** prefer a model family different from the coder's, at high effort; agreement inside
  one family adds little. With a single provider available, ask the user which reviewer to use,
  unless they gave you authority to choose; then choose and record a ruling.
- **Scouts and research:** the cheapest model, with a tight brief that demands quotes and paths.
- **Parallelism:** as many coders as the machine and the quota bear. Ask, with the reason, before
  going above the user's limit.
- **Shared quota:** if workers draw on your quota, check the reset time and plan a check-in after it.

## Staying cheap

- Resume a worker for work that continues what it knows; its cache and its reasons carry over.
  `references/review.md` lists the three cases where a new agent is better.
- Name an installed skill (a review skill, a PR-writing skill) in place of a checklist.
- Read summaries: PR metadata, agent status, the last lines of activity. Read a diff hunk only to
  settle a dispute.
- Have workers run targeted tests and leave the full suite to CI. Trust their test evidence; rerun
  a check only on a gap or a contradiction.
- Workers start no reviewers of their own; the review you dispatch is the one that counts.
- A finished task is one ledger line. Archive finished agents so status listings stay short.

## Defaults

Override any of these in the user's request or the repo's own rules.

- Two coders in parallel; ask before running more, four at most.
- Coder: a strong model at medium effort. Reviewer: a model from a different family at high effort,
  or none for low-risk tasks. Check the tool's model list for current names.
- Workers run in their own worktree, with the permissions the repo's rules allow.
- Merge normally when the gate passes and there is no conflict; then update the local base. Use
  admin or bypass merges only when the user has said so.
- Open PRs as drafts and mark them ready after review only in repos whose CI skips drafts. In other
  repos open them ready, so checks and bots run during review.
- Deferred findings go into the PR description as a checklist; file an issue only when asked.

## References

| File | Read it when |
| --- | --- |
| `references/tools.md` | before the first dispatch, and whenever a tool call misbehaves |
| `references/contracts.md` | opening the ledger; writing a brief; reading a report |
| `references/review.md` | a review returns, a fix round starts, or a loop will not end |
| `references/supervision.md` | you are about to wait, a worker is silent, CI is not green |
| `references/pitfalls.md` | before the first merge, and when a GitHub or ownership question comes up |
