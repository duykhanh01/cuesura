# Canonical contracts

## Run and writers

Keep the run outside disposable worktrees, normally
`~/.agents/orchestrate/runs/<repo>-<YYYYMMDD>-<slug>/`. Lead owns `ledger.md` and `briefs/`;
each role owns its `reports/<task>-<role>.md`. `notes/` holds shared investigation. Archive links
records rather than copying their bodies. Remote workers need accessible copies, not a path on
another machine. The Git common directory is an alternative durable location if needed.

The ledger is a routing index: goal/source/grant, allowed workers/profiles/effort/escalation,
advisor mode/scope, repo/base, CI policy, run rules (including language), active tasks, ownership,
active decisions and archive references. Keep detailed evidence and findings in role reports.
A size around 120 lines or 3,000 approximate tokens prompts consolidation, not automatic deletion.
After compaction, read archive only for a specific dependency or question.

## Ledger table

The helper accepts this exact section and columns; `-` means absent. Cells cannot contain literal
pipes or newlines. Task IDs match `T[1-9][0-9]*(.[1-9][0-9]*)*`. Parent must be the immediate dotted
prefix; root tasks use `-`. Do not renumber IDs when splitting work.

```markdown
# Ledger — goal — date

Source: ticket or approved plan
Grant: stop-at-ready; allowed decisions and escalation
Workers: total limit; permitted models/profiles/effort
Advisor: none, advise, or decide with scope/exclusions
Repository: remote, base and verified base checkpoint; CI policy path

## Active tasks
| Task | Parent | Phase | Outcome | Owner | Depends | Head | Reviewed | Brief | Report | Block | Next |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T4 | - | tracking | - | lead:id | - | - | - | - | - | - | integration criteria source; wake |
| T4.1 | T4 | coding | - | coder:id; reviewer:id | - | - | - | briefs/T4.1-coder.md | reports/T4.1-coder.md | - | next action; wake |

## Decisions
- T4-D1: active; reports/T4-advisor.md; applies to T4.1 and T5

## Deferred
- T4.1/F2: reason; tracking link; revisit condition

## Archive
- [Index](archive/index.md)
```

Owner is the sole agent-ID map; include role labels and additional role report links in Next when
needed. Phase remains unchanged while Block names reason/evidence and unblock condition. Next
records the resume step, wake and integration checkpoint. Depends uses comma-separated stable IDs;
resolve against both active table and archive index, checking the outcome, not mere absence.
Risk, owned area and acceptance criteria live in the linked brief. Head and Reviewed use full SHAs.

Outcome is lead-assigned: `-` while active, then `merged`, `accepted`, `handed-off`, `cancelled` or
`superseded`. DONE in a role report is not an automatic terminal task outcome. Parents complete
only after required children and integration criteria. A report task can be accepted without a PR;
a handed-off PR cannot satisfy a merge dependency. Keep rows until archived. Update after material
changes and before waiting; never edit the ledger concurrently with the helper.

## Briefs and revisions

Use the role template: [coder](../templates/coder.md), [reviewer](../templates/reviewer.md),
[advisor](../templates/advisor.md), or [follow-up](../templates/follow-up.md).

```bash
bash /absolute/skill-dir/scripts/task.sh brief create <run-dir> <task-id> <coder|reviewer|advisor|follow-up>
bash /absolute/skill-dir/scripts/task.sh brief check <brief-path>
```

The Bash entry point delegates parsing and atomic writes to [task.py](../scripts/task.py).
Create writes `briefs/<task>-<role>.md` exclusively, fills Task/Parent/Revision/Report and prints
only its absolute path. Fill every uppercase `{{PLACEHOLDER}}` before checking; this syntax is
reserved for scaffolds. Literal HTML, generic types and ordinary template expressions are allowed.
The check validates required sections, role/ID/revision, absolute report path under an existing
directory and required Read paths.
Each Read bullet is `- /absolute/file#optional-section — purpose` or an HTTPS URL. Use `- none`
only if no source reading is necessary. Local files must exist; remote URLs are shape-checked only,
not fetched. Output report may not exist yet. Templates are scaffolds, not ready dispatches.

Goal/scope/criteria changes increment Revision in the same canonical file. Record meaningful
revision history/deltas in the role report and send affected workers the delta. Typo fixes need no
revision bump. Reports name the revision handled; stale revisions need reconciliation before review.
For follow-up scaffolds, set Report to the actual recipient’s existing role report before sending.
Ordinary fixes/re-checks send findings, exact head/range and decisions using the follow-up shape;
no file per short message is needed. Briefs roughly 400–800 tokens and deltas 100–250 are guides,
not gates. The checker reports a character-based estimate, not tokenizer counts. File reads still
cost context: keep critical conditions visible and link specific sections with a reading purpose.

## Role reports and handoff

Put current status first: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`; task/role,
brief revision, PR/head/base or report outcome, current findings/decisions, commands/results,
unverified limits and next step. Keep relevant history below this summary.

Coder: behavior, validation evidence at the named commit, one answer per finding, queued requests
still open. Reviewer: exact reviewed SHA, stable F IDs, quoted code/file/line, concrete scenario,
impact, route and resolution evidence. Advisor: decision records per [advisor.md](advisor.md).
Scout: ranked evidence/reproductions and uncovered areas in notes; no invented timing minimum.
Reply concisely with status, PR/head or decision IDs, conclusion and report path.

Replacement workers read current brief and report summary first; follow links only as needed. A
lead handoff points at ledger/report/PR, active decisions, outstanding requests and the next step.
Reconcile live state before acting, including work left by disappeared agents.

## Archive protocol

```bash
bash /absolute/skill-dir/scripts/task.sh archive <run-dir> <task-id>
```

Lead marks terminal outcomes and confirms decision references/deferred tracking first. Helper
refuses malformed canonical tables or a target with live descendants. Archiving a parent includes
its terminal descendants; archiving a child leaves the parent active and updates its Next progress.
History groups by root task (`archive/T4.md`), timestamped per task; `archive/index.md` retains
Task/Parent/Outcome/time/Evidence/History, including full commits or report references. Use Evidence
from Head and Report; keep PR URLs in the report. Parent completion remains a lead decision.

Tracking parents do not need artificial advisor briefs/reports. Tasks cancelled or superseded while
still queued may also have never acquired those records. In these cases, Brief/Report may be `-`;
Next must contain the lead's closure reason or integration result and its evidence references. The
index preserves this explanation when no report exists. Any declared file must still exist, and
ordinary completed worker tasks still require their records.

Helper writes history first, index second, ledger last with atomic file replacements and an
exclusive helper lock. Repeating after interruption reconciles already-written entries without
duplicates; conflicting archived outcomes/evidence fail rather than overwrite. Brief/report paths
remain stable, and unrelated ledger prose (including active decisions) stays intact. No agent,
branch or workspace is deleted. Do not change terminal rows between an interrupted archive and its
retry; inspect mismatches. Do not run a manual ledger edit concurrently; the lock covers helpers
only. Retired shared decisions belong in `archive/run-decisions.md` with links to their source;
the lead maintains these, since a script cannot infer authority or continuing applicability.
