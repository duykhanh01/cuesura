/**
 * The goal branch (007, R-23, contracts/goal.md): `git.create_goal_branch` pushes the base SHA recorded at
 * the confirmation to `refs/heads/<branch>` and records `GoalBranchCreated`; units then triage again.
 *
 * Probe first, push only on an absent ref: a branch already at the base SHA is a push whose answer was
 * lost (the record follows, nothing is pushed twice); a branch anywhere else is someone else's, so nothing
 * is overwritten and the goal asks for a new plan. Derived from committed state on every pass, so a crash
 * between the push and the record loses nothing.
 */
import { probeRemote, pushBranch } from '../adapters/git/push.ts';
import type { Clock, GitPort } from '../adapters/ports.ts';
import { submit } from '../application/triage.ts';
import type { GoalState } from '../domain/goal.ts';
import {
  goalMark,
  recordGoalDrift,
  sameMark,
  verifyAgainstStore,
} from '../application/goal-tip.ts';
import { readGoalBranch } from '../adapters/git/goal-branch.ts';
import { isTerminal } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

export type GoalBranchDeps = {
  readonly store: Store;
  readonly git: GitPort;
  readonly clock: Clock;
  readonly remoteUrl: (repo: string) => string;
  /** The project's checkout and GitHub repo from the user config; null when it cannot be read. */
  readonly location: (project: string) => Promise<{ path: string; repo: string } | null>;
  readonly log?: (line: string) => void;
};

export type GoalBranchOutcome = 'created' | 'conflict' | 'unknown' | 'not_due';

const LIVE = ['running', 'amendment_pending', 'replan'] as const;

/** One `git.create_goal_branch` for a goal whose branch is named but not recorded yet. */
export async function createGoalBranch(
  deps: GoalBranchDeps,
  g: GoalState,
): Promise<GoalBranchOutcome> {
  const base = g.branch_base_sha ?? null;
  if (g.branch === null || base === null || g.branch_created === true) return 'not_due';
  const where = await deps.location(g.project);
  if (where === null) return 'unknown';
  const remote = deps.remoteUrl(where.repo);
  const record = (sha: string): GoalBranchOutcome => {
    const r = deps.store.goals.accept({
      goal_id: g.id,
      dedup_key: `goal-branch:${g.id}:${g.branch ?? ''}`,
      now: deps.clock.now(),
      actor: 'system:goal',
      trigger: { kind: 'branch_created', sha },
    });
    return r.ok ? 'created' : 'unknown';
  };
  const conflict = (at: string | null): GoalBranchOutcome => {
    deps.log?.(`goal ${g.id}: branch ${g.branch ?? ''} exists at ${at ?? 'an unknown head'}`);
    const r = deps.store.goals.accept({
      goal_id: g.id,
      dedup_key: `goal-branch-conflict:${g.id}:${g.version}`,
      now: deps.clock.now(),
      actor: 'system:goal',
      expected_version: g.version,
      trigger: { kind: 'replan', reason: 'goal_branch_exists' },
    });
    return r.ok ? 'conflict' : 'unknown';
  };
  const before = await probeRemote(deps.git, where.path, remote, g.branch);
  if (before.kind === 'unknown') return 'unknown';
  if (before.kind === 'at') return before.sha === base ? record(base) : conflict(before.sha);
  const pushed = await pushBranch(deps.git, {
    cwd: where.path,
    remote_url: remote,
    branch: g.branch,
    expected_old: null,
    new_sha: base,
    // A ref that appears after the probe is someone else's, wherever it points: never moved.
    create_only: true,
  });
  if (pushed.kind === 'pushed' || pushed.kind === 'already_pushed') return record(base);
  if (pushed.kind === 'head_changed') return conflict(pushed.remote_sha);
  deps.log?.(`goal ${g.id}: branch ${g.branch} not created: ${pushed.kind}`);
  return 'unknown';
}

/** Units still waiting for a branch that exists now get `goal_branch_ready`. */
function wakeUnits(deps: GoalBranchDeps, g: GoalState): string[] {
  const woken: string[] = [];
  for (const row of deps.store.goals.tasks(g.id)) {
    if (row.role !== 'unit') continue;
    const s = deps.store.readTask(row.task_id as Uuid);
    if (s?.status !== 'PENDING' || s.wait?.detail['goal_branch'] === undefined) continue;
    const r = submit(deps.store, {
      task_id: s.id,
      dedup_key: `goal-branch-ready:${s.id}:${s.version}`,
      trigger: { kind: 'goal_branch_ready' },
      now: deps.clock.now(),
    });
    if (r.ok && !r.value.duplicate) woken.push(s.id);
  }
  return woken;
}

/**
 * The safety net (review of #294): a push by hand to the goal branch while no write is about to check
 * it. Each write judges the branch itself before it writes; this round only notices earlier. Skipped while a unit merge is in flight
 * (its merge commit is not recorded yet) and once the integration task started (it publishes to the goal
 * branch itself, guarded by its own push). The goal is marked before the fetch; if anything the
 * comparison depends on changed meanwhile, this pass drops the read and the next one fetches again.
 */
async function checkDrift(deps: GoalBranchDeps, g: GoalState): Promise<void> {
  if (g.status !== 'running' || g.branch === null || g.branch_created !== true) return;
  const final = g.final_task_id === null ? null : deps.store.readTask(g.final_task_id as Uuid);
  if (final === null || final.policy_ref !== null || isTerminal(final.status)) return;
  const before = goalMark(deps.store, g.id, null);
  if (before === null || before.in_flight !== null) return;
  const where = await deps.location(g.project);
  if (where === null) return;
  const read = await readGoalBranch(deps.git, {
    cwd: where.path,
    remote: deps.remoteUrl(where.repo),
    branch: g.branch,
    base: g.branch_base_sha ?? '',
    into: `refs/cusr/goal/${g.id}`,
  });
  if (read === null) return;
  // Nothing awaited from here to the record.
  const now = deps.store.goals.read(g.id);
  const finalNow = g.final_task_id === null ? null : deps.store.readTask(g.final_task_id as Uuid);
  if (now === null || !sameMark(before, goalMark(deps.store, g.id, null))) return;
  if (finalNow === null || finalNow.policy_ref !== null) return;
  const verdict = verifyAgainstStore(deps.store, now, read);
  if (verdict.ok) return;
  deps.log?.(
    `goal ${now.id}: branch ${now.branch ?? ''} at ${read.tip} is not what the daemon wrote: ${verdict.reason}`,
  );
  recordGoalDrift(deps.store, now.id, read.tip, deps.clock.now());
}

/**
 * One pass over live goals: create the branches due, then wake the units that waited for them. The daemon
 * runs one pass at a time and awaits it on stop.
 */
export async function goalBranchRound(deps: GoalBranchDeps): Promise<void> {
  for (const g of deps.store.goals.list({ statuses: [...LIVE], limit: 500 })) {
    if (g.branch === null) continue;
    if (g.branch_created !== true) await createGoalBranch(deps, g);
    const now = deps.store.goals.read(g.id);
    if (now?.branch_created === true) wakeUnits(deps, now);
    if (now !== null) await checkDrift(deps, now);
  }
}
