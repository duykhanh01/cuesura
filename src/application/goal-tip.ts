/**
 * The goal branch's integrity (007, R-23, R-24), decided in one place.
 *
 * Until the integration task starts only the daemon writes a goal branch, so its first-parent history
 * from the goal's base is exactly the merge commits the daemon recorded, in the order it recorded them
 * (the ledger). `verifyGoalBranch` is the one judge of that. Every write that relies on it (a unit's
 * merge, a unit's base update onto the branch, the integration task's start) reads the branch last,
 * then, with nothing awaited, checks the goal against the mark it took before awaiting and calls the
 * judge, and only then writes. The goal branch round is a safety net, not the guarantee.
 */
import type { GoalBranchRead } from '../adapters/git/goal-branch.ts';
import type { GoalState } from '../domain/goal.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';
import { targetsGoalBranch, yoloApproval } from '../engine/external-completion.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

export type GoalBranchVerdict =
  | { readonly ok: true; readonly tip: string }
  | { readonly ok: false; readonly tip: string | null; readonly reason: string };

/**
 * Pure: whether a goal branch as read is the branch the daemon wrote. `history` is the first-parent
 * history from the tip, newest first, down to and including `branch_base_sha`; `ledger` the merge
 * commits the daemon recorded there, oldest first. The two must be the same commits: no commit before,
 * between or after them, the base where it was created, nothing missing.
 */
export function verifyGoalBranch(o: {
  readonly branch_base_sha: string;
  readonly history: readonly string[];
  readonly ledger: readonly string[];
}): GoalBranchVerdict {
  const tip = o.history[0] ?? null;
  const expected = [...o.ledger].reverse().concat(o.branch_base_sha);
  if (o.history.length !== expected.length)
    return {
      ok: false,
      tip,
      reason: `first-parent history has ${o.history.length} commits, ${expected.length} expected`,
    };
  const at = o.history.findIndex((sha, i) => sha !== expected[i]);
  if (at >= 0)
    return {
      ok: false,
      tip,
      reason: `first-parent commit ${at} is ${o.history[at] ?? ''}, not ${expected[at] ?? ''}`,
    };
  return { ok: true, tip: tip as string };
}

/**
 * The goal whose branch this unit targets, while units may merge there: confirmed, branch created, and
 * `running`. A goal that replans, waits for an amendment or ended merges nothing (R-23).
 */
export function mergingGoal(store: Store, s: TaskState): GoalState | null {
  if (!targetsGoalBranch(s)) return null;
  const g = store.goals.read(s.task.goal?.id ?? '');
  if (g === null || g.branch !== s.task.base_branch || g.branch_created !== true) return null;
  return g.status === 'running' ? g : null;
}

/** Another unit of the goal approved for its head and not merged yet: it holds the goal branch. */
export function unitMergeInFlight(
  store: Store,
  g: GoalState,
  except: string | null,
): string | null {
  for (const row of store.goals.tasks(g.id)) {
    if (row.role !== 'unit' || row.task_id === except) continue;
    const o = store.readTask(row.task_id as Uuid);
    if (o === null || isTerminal(o.status) || o.completion !== null || o.head_sha === null)
      continue;
    if (yoloApproval(o, o.head_sha) !== undefined) return o.id;
  }
  return null;
}

/**
 * The merge commits the daemon recorded on the goal branch, oldest first, ordered by the log position of
 * the event that recorded each (never a clock: one may step back). Merges into a goal branch go one at a
 * time, each recorded before the next is approved, so this is the order they happened in.
 */
export function goalLedger(store: Store, g: GoalState): string[] {
  const merges: { seq: number; sha: string }[] = [];
  for (const row of store.goals.tasks(g.id)) {
    if (row.role !== 'unit') continue;
    const s = store.readTask(row.task_id as Uuid);
    const proof = s?.completion?.proof;
    if (s == null || proof === undefined || proof.subject.target_ref !== g.branch) continue;
    const recorded = store
      .readEvents(s.id as Uuid)
      .findLast((e) => e.type === 'ExternalCompletionObserved');
    if (recorded !== undefined)
      merges.push({ seq: recorded.global_seq, sha: proof.merge_commit_sha });
  }
  return merges.sort((a, b) => a.seq - b.seq).map((m) => m.sha);
}

/** The goal branch as read, judged against the ledger the store holds now. */
export function verifyAgainstStore(
  store: Store,
  g: GoalState,
  read: Pick<GoalBranchRead, 'history'>,
): GoalBranchVerdict {
  if (g.branch_base_sha == null)
    return { ok: false, tip: read.history[0] ?? null, reason: 'goal branch has no base' };
  return verifyGoalBranch({
    branch_base_sha: g.branch_base_sha,
    history: read.history,
    ledger: goalLedger(store, g),
  });
}

/**
 * What a write to the goal branch was decided on, taken before awaiting the remote. The write goes on
 * only if the mark is the same when the answer is back; otherwise this pass drops it and the next one
 * reads everything again, so two moments are never compared (review of #294).
 */
export type GoalMark = {
  readonly status: GoalState['status'];
  readonly ledger: string;
  readonly in_flight: string | null;
};

export function goalMark(store: Store, goalId: string, except: string | null): GoalMark | null {
  const g = store.goals.read(goalId);
  if (g === null) return null;
  return {
    status: g.status,
    ledger: goalLedger(store, g).join(','),
    in_flight: unitMergeInFlight(store, g, except),
  };
}

export const sameMark = (a: GoalMark | null, b: GoalMark | null): boolean =>
  a !== null &&
  b !== null &&
  a.status === b.status &&
  a.ledger === b.ledger &&
  a.in_flight === b.in_flight;

/**
 * The goal branch is not what the daemon wrote: the goal replans. Called with nothing awaited since the
 * branch was read and judged; keyed by the goal version, so a drift seen while the goal could not
 * replan is recorded once it can.
 */
export function recordGoalDrift(store: Store, goalId: string, tip: string, now: number): boolean {
  const g = store.goals.read(goalId);
  if (g === null || g.status !== 'running') return false;
  const r = store.goals.accept({
    goal_id: g.id,
    dedup_key: `goal-branch-drift:${g.id}:${g.version}:${tip}`,
    now,
    actor: 'system:goal',
    expected_version: g.version,
    trigger: { kind: 'replan', reason: 'goal_branch_drift' },
  });
  return r.ok && r.value.decision.kind === 'accepted';
}

/**
 * Why an integration task may not start on the goal branch now; null when it may. The goal must still
 * run, no unit merge may be in flight, and the branch preflight read (when given) must pass the judge,
 * so a push by hand never reaches the goal's PR (R-24). Called right before the start is submitted,
 * with nothing awaited after.
 */
export function integrationStartProblem(
  store: Store,
  s: TaskState,
  read: GoalBranchRead | null,
): string | null {
  if (s.task.goal?.role !== 'final') return null;
  const g = store.goals.read(s.task.goal.id);
  if (g === null || g.status !== 'running' || g.branch_created !== true)
    return `goal_not_running:${g?.status ?? 'missing'}`;
  if (unitMergeInFlight(store, g, null) !== null) return 'goal_merge_in_flight';
  if (read === null) return null;
  return verifyAgainstStore(store, g, read).ok ? null : `goal_branch_drift:${read.tip}`;
}

/** What preflight needs to read an integration task's goal branch: the base it must grow from. */
export function integrationInput(
  store: Store,
  s: TaskState,
): { readonly integration?: { readonly branch_base_sha: string } } {
  if (s.task.goal?.role !== 'final') return {};
  const base = store.goals.read(s.task.goal.id)?.branch_base_sha ?? null;
  return base === null ? {} : { integration: { branch_base_sha: base } };
}
