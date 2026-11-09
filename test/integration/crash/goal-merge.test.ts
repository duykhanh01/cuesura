import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advanceTaskPr } from '../../../src/daemon/yolo.ts';
import { planHash } from '../../../src/engine/plan.ts';
import { startTask } from '../../../src/application/start.ts';
import { configuredSelection } from '../../support/preflight-fakes.ts';
import { proposeAndConfirm } from '../../support/runtime.ts';
import { goalPlan, planUnit } from '../../support/goal.ts';
import { goalFlowEnv } from '../../support/goal-flow.ts';

// 007 T073, SC-004 for merges: a daemon that dies between creating the goal branch and recording it,
// or after sending a unit's merge into the goal branch, leaves one branch and one merge commit per
// unit; two units never merge into one goal branch at once; a push by hand to the goal branch stops
// every merge and asks for a new plan.

const { g, setup } = goalFlowEnv('cusr-goal-merge-');

const PLAN = goalPlan([
  planUnit('a', { scope: ['src/a'] }),
  planUnit('b', { scope: ['src/b'] }),
  planUnit('c', { scope: ['src/c'], depends_on: ['a', 'b'] }),
]);

const firstParentMerges = (remote: string, base: string, branch: string): string[] =>
  g
    .sh(remote, 'rev-list', '--first-parent', '--merges', `${base}..refs/heads/${branch}`)
    .split('\n')
    .filter((l) => l !== '');

describe('goal branch and merges across a restart', () => {
  it('records a goal branch pushed by a daemon that died before its record, once', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const base = f.tip('main');
    // The dying daemon's push reached the remote; its record did not reach the store.
    g.sh(f.remote, 'update-ref', `refs/heads/${goal.branch}`, base);
    await f.restart();
    await f.round();
    await f.round();
    expect(f.tip(goal.branch)).toBe(base);
    const created = f.store.goals.events(goal.goalId).filter((e) => e.type === 'GoalBranchCreated');
    expect(created).toHaveLength(1);
    expect(f.task(goal.units['a'] as string).wait?.detail['goal_branch']).toBeUndefined();
  });

  it('sends one merge at a time per goal branch, and never a second after a lost answer', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const base = f.tip('main');
    const a = goal.units['a'] as string;
    const b = goal.units['b'] as string;
    f.control.merge = false;
    await f.until(
      () => f.task(a).wait?.detail.code === 'merge' && f.task(b).wait?.detail.code === 'merge',
    );

    // Both units ask at once; the one that goes first loses the answer of a merge that happened.
    f.github.loseNextMergeAnswer = true;
    const raced = await Promise.all([advanceTaskPr(f.yolo(), a), advanceTaskPr(f.yolo(), b)]);
    expect([...raced].sort()).toEqual(['merge_in_flight', 'unknown']);
    expect(f.github.merges).toBe(1);
    const merged = raced[0] === 'unknown' ? a : b;
    const other = merged === a ? b : a;

    await f.restart();
    // The approved merge holds the branch across the restart until it is observed.
    expect(await advanceTaskPr(f.yolo(), other)).toBe('merge_in_flight');
    // Sent again, the merged PR is no longer open: nothing is sent.
    await advanceTaskPr(f.yolo(), merged);
    expect(f.github.merges).toBe(1);

    f.control.merge = true;
    await f.until(() => f.task(goal.final).wait?.detail.code === 'merge');
    expect(f.github.merges).toBe(3);
    expect(firstParentMerges(f.remote, base, goal.branch)).toHaveLength(3);
    expect(f.store.goals.read(goal.goalId)?.status).toBe('running');
  });

  it('stops merging and asks for a new plan when someone pushes to the goal branch', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    f.control.merge = false;
    await f.until(() => f.task(a).wait?.detail.code === 'merge');

    const clone = join(g.base, `hand-${goal.goalId}`);
    g.sh(g.base, 'clone', '-q', '-b', goal.branch, f.remote, clone);
    writeFileSync(join(clone, 'hand.txt'), 'by hand\n');
    g.sh(clone, 'add', '-A');
    g.sh(clone, 'commit', '-qm', 'by hand');
    g.sh(clone, 'push', '-q', 'origin', goal.branch);

    expect(await advanceTaskPr(f.yolo(), a)).toBe('goal_branch_drift');
    expect(f.github.merges).toBe(0);
    const after = f.store.goals.read(goal.goalId);
    expect(after?.status).toBe('replan');
    expect(after?.replan_reason).toBe('goal_branch_drift');
    // While the goal replans no unit merges into its branch or takes its tip.
    expect(await advanceTaskPr(f.yolo(), a)).toBe('goal_held');
    expect(f.github.merges).toBe(0);
  });

  it('does not merge when the goal starts to replan while the daemon reads CI (review #294, 1)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    f.control.merge = false;
    await f.until(() => f.task(a).wait?.detail.code === 'merge');
    // The owner revises the request while the merge reads the checks: the task's version is unchanged.
    f.github.beforeNext = () => {
      const g0 = f.store.goals.read(goal.goalId);
      const r = f.store.goals.accept({
        goal_id: goal.goalId,
        dedup_key: `revise:${goal.goalId}`,
        now: 1_800_000_000_000,
        actor: 'owner',
        expected_version: g0?.version ?? 0,
        trigger: { kind: 'revise', request: 'Export the report as JSON too.' },
      });
      if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
    };
    expect(await advanceTaskPr(f.yolo(), a)).toBe('goal_held');
    expect(f.store.goals.read(goal.goalId)?.status).toBe('replan');
    expect(f.github.merges).toBe(0);
    expect(f.tip(goal.branch)).toBe(f.store.goals.read(goal.goalId)?.branch_base_sha);
  });

  it('does not start the integration task on a goal branch pushed to after the last unit (review #294, 2)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const units = Object.values(goal.units);
    await f.until(() => units.every((u) => f.task(u).status === 'DONE'));
    const merged = f.tip(goal.branch);
    pushByHand(f.remote, goal.branch, `hand-final-${goal.goalId}`);
    for (let i = 0; i < 4; i++) await f.round();
    const after = f.store.goals.read(goal.goalId);
    expect(after?.status).toBe('replan');
    expect(after?.replan_reason).toBe('goal_branch_drift');
    expect(f.task(goal.final).policy_ref).toBeNull();
    expect(f.github.prs.some((p) => p.head.ref === goal.branch)).toBe(false);
    expect(f.tip(goal.branch)).not.toBe(merged);
  });

  it('records drift seen while an amendment waits, once the goal can replan (review #294, 3)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    f.control.merge = false;
    await f.until(() => f.task(a).wait?.detail.code === 'merge');
    const g0 = f.store.goals.read(goal.goalId);
    const plan = { ...(g0?.plan as NonNullable<typeof g0>['plan'] & object) };
    const amended = { ...plan, summary: `${plan.summary} and JSON` };
    const amend = f.store.goals.accept({
      goal_id: goal.goalId,
      dedup_key: `amend:${goal.goalId}`,
      now: 1_800_000_000_000,
      actor: 'owner',
      expected_version: g0?.version ?? 0,
      trigger: {
        kind: 'amend',
        plan: amended,
        plan_version: g0?.plan_version ?? 0,
        plan_hash: planHash(amended),
        amendment: 'scope',
        affected: [],
      },
    });
    expect(amend.ok && amend.value.decision.kind).toBe('accepted');
    expect(f.store.goals.read(goal.goalId)?.status).toBe('amendment_pending');

    pushByHand(f.remote, goal.branch, `hand-amend-${goal.goalId}`);
    // While the amendment waits no unit merges into the goal branch.
    expect(await advanceTaskPr(f.yolo(), a)).not.toBe('merged');
    expect(f.github.merges).toBe(0);

    const g1 = f.store.goals.read(goal.goalId);
    const confirm = f.store.goals.accept({
      goal_id: goal.goalId,
      dedup_key: `confirm-amend:${goal.goalId}`,
      now: 1_800_000_000_000,
      actor: 'owner',
      expected_version: g1?.version ?? 0,
      trigger: { kind: 'confirm', plan_hash: planHash(amended), units: {} },
    });
    expect(confirm.ok && confirm.value.decision.kind).toBe('accepted');
    expect(f.store.goals.read(goal.goalId)?.status).toBe('running');
    expect(await advanceTaskPr(f.yolo(), a)).toBe('goal_branch_drift');
    expect(f.github.merges).toBe(0);
    const after = f.store.goals.read(goal.goalId);
    expect(after?.status).toBe('replan');
    expect(after?.replan_reason).toBe('goal_branch_drift');
  });

  it('does not merge a head that lacks a push made while the daemon reads CI (review #294 re-check, 1)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    f.control.merge = false;
    await f.until(() => f.task(a).wait?.detail.code === 'merge');
    const base = f.tip(goal.branch);
    f.github.beforeNext = () => pushByHand(f.remote, goal.branch, `hand-ci-${goal.goalId}`);
    expect(await advanceTaskPr(f.yolo(), a)).not.toBe('merged');
    expect(f.github.merges).toBe(0);
    expect(f.tip(goal.branch)).not.toBe(base);
    const after = f.store.goals.read(goal.goalId);
    expect(after?.status).toBe('replan');
    expect(after?.replan_reason).toBe('goal_branch_drift');
  });

  it('takes no merge recorded while its probe was out for a drift (review #294 re-check, 2)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    f.control.merge = false;
    await f.until(() => f.task(a).wait?.detail.code === 'merge');
    // The probe reads the branch before A's merge; A merges and is observed before the probe answers.
    f.gitHook.afterProbe = async () => {
      expect(await advanceTaskPr(f.yolo(), a)).toBe('merged');
      await f.observe(a);
    };
    await f.branchRound();
    expect(f.gitHook.afterProbe).toBeNull();
    expect(f.task(a).completion?.proof.merge_commit_sha).toBe(f.tip(goal.branch));
    expect(f.store.goals.read(goal.goalId)?.status).toBe('running');
    // The next round sees the branch as the daemon wrote it.
    await f.branchRound();
    expect(f.store.goals.read(goal.goalId)?.status).toBe('running');
  });

  it('catches a push that slipped into a unit merge after its last read (first-parent history)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    f.control.merge = false;
    await f.until(() => f.task(a).wait?.detail.code === 'merge');
    // The window no check can close: a push lands between the daemon's last read and GitHub's merge.
    f.github.beforeMerge = () => pushByHand(f.remote, goal.branch, `hand-late-${goal.goalId}`);
    expect(await advanceTaskPr(f.yolo(), a)).toBe('merged');
    await f.observe(a);
    expect(f.task(a).completion?.proof.merge_commit_sha).toBe(f.tip(goal.branch));
    // The tip is the merge commit the daemon recorded, but its first parent is the push: the goal replans
    // before anything else merges or the integration task starts.
    await f.branchRound();
    const after = f.store.goals.read(goal.goalId);
    expect(after?.status).toBe('replan');
    expect(after?.replan_reason).toBe('goal_branch_drift');
  });

  it('lets no next unit base-update or merge onto a merge a push slipped into (review #294 round 3, 1)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    const b = goal.units['b'] as string;
    f.control.merge = false;
    await f.until(
      () => f.task(a).wait?.detail.code === 'merge' && f.task(b).wait?.detail.code === 'merge',
    );
    f.github.beforeMerge = () => pushByHand(f.remote, goal.branch, `hand-r3-${goal.goalId}`);
    expect(await advanceTaskPr(f.yolo(), a)).toBe('merged');
    await f.observe(a);
    // A's merge commit is recorded and is the tip, but its first parent is the push. No round runs here.
    expect(await advanceTaskPr(f.yolo(), b)).toBe('goal_branch_drift');
    expect(f.github.merges).toBe(1);
    expect(f.task(b).run.base_update ?? null).toBeNull();
    expect(f.store.goals.read(goal.goalId)?.status).toBe('replan');
  });

  it('keeps the merges in the order the store recorded them when the clock goes back (round 3, 4)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    const b = goal.units['b'] as string;
    f.control.merge = false;
    await f.until(
      () => f.task(a).wait?.detail.code === 'merge' && f.task(b).wait?.detail.code === 'merge',
    );
    expect(await advanceTaskPr(f.yolo(), a)).toBe('merged');
    await f.observe(a);
    // The wall clock steps back an hour before B's merge is recorded.
    f.setNow(f.now() - 3_600_000);
    f.control.merge = true;
    await f.until(
      () =>
        f.task(goal.final).wait?.detail.code === 'merge' ||
        f.store.goals.read(goal.goalId)?.status !== 'running',
    );
    expect(f.store.goals.read(goal.goalId)?.status).toBe('running');
    expect(f.github.merges).toBe(3);
  });

  it('starts the integration task when the base branch already took part of the goal (round 3, 3)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    f.control.startFinal = false;
    const units = Object.values(goal.units);
    await f.until(() => units.every((u) => f.task(u).status === 'DONE'));
    // Someone merged the goal branch's first unit into main: main's merge-base with the goal moves.
    const merges = firstParentMerges(f.remote, f.tip('main'), goal.branch).reverse();
    g.sh(f.remote, 'update-ref', 'refs/heads/main', merges[0] as string);
    await f.round();
    const s = f.task(goal.final);
    expect(s.status).toBe('READY');
    expect(s.execution.holding).not.toBeNull();
    proposeAndConfirm(f.d, s.task, await configuredSelection(s.task, 'direct-pr'));
    const r = await startTask(f.startDeps(), goal.final);
    expect(r, JSON.stringify(r)).toMatchObject({ kind: 'submitted', frozen: true });
    expect(f.store.readRuntimeContext(goal.final as never, 1)?.start_sha).toBe(f.tip(goal.branch));
    expect(f.store.goals.read(goal.goalId)?.status).toBe('running');
  });
});

function pushByHand(remote: string, branch: string, dir: string): void {
  const clone = join(g.base, dir);
  g.sh(g.base, 'clone', '-q', '-b', branch, remote, clone);
  writeFileSync(join(clone, 'hand.txt'), `by hand ${dir}\n`);
  g.sh(clone, 'add', '-A');
  g.sh(clone, 'commit', '-qm', 'by hand');
  g.sh(clone, 'push', '-q', 'origin', branch);
}
