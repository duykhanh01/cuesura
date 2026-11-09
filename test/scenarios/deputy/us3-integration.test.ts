import { describe, expect, it } from 'vitest';
import { goalPlan, planUnit } from '../../support/goal.ts';
import { goalFlowEnv } from '../../support/goal-flow.ts';

// 007 US3 (integration), T072, SC-012: a goal of three units (A and B independent, C after both) runs
// from its confirmation to a ready PR of the goal without a person: units merge into the goal branch
// by the plan (`policy:goal`), a unit behind the goal branch is brought up to date and checked again
// first, C starts from the goal branch tip, and the integration task opens the goal's PR.

const { g, setup } = goalFlowEnv('cusr-us3-int-');

const PLAN = goalPlan([
  planUnit('a', { scope: ['src/a'] }),
  planUnit('b', { scope: ['src/b'] }),
  planUnit('c', { scope: ['src/c'], depends_on: ['a', 'b'] }),
]);

describe('US3: a goal with several units goes to one PR', () => {
  it('runs A and B together, C from the goal branch, and opens the goal PR (scenarios 5–7)', async () => {
    const f = setup(PLAN);
    const goal = f.confirm();
    const a = goal.units['a'] as string;
    const b = goal.units['b'] as string;
    const c = goal.units['c'] as string;
    const base = f.tip('main');

    // Units wait for the goal branch; the first pass creates it at the confirmed base.
    expect(f.task(a).wait?.detail['goal_branch']).toBe(goal.branch);
    await f.round();
    expect(f.tip(goal.branch)).toBe(base);
    expect(f.store.goals.read(goal.goalId)?.branch_created).toBe(true);

    // A and B run side by side: both started before either merged.
    await f.until(() => f.task(a).policy_ref !== null && f.task(b).policy_ref !== null, 10);
    expect(f.github.merges).toBe(0);
    expect(f.task(c).status).toBe('PENDING');

    await f.until(() => f.task(a).status === 'DONE' && f.task(b).status === 'DONE');
    const [first, second] = [f.task(a), f.task(b)].sort(
      (x, y) => (x.completion?.proof.merged_at ?? 0) - (y.completion?.proof.merged_at ?? 0),
    );
    // The second unit to merge was behind the goal branch: it took the first's merge, then CI again.
    expect(second?.run.base_update?.base_sha).toBe(first?.completion?.proof.merge_commit_sha);
    expect(new Set(second?.evidence.ci.map((x) => x.head_sha)).size).toBeGreaterThan(1);
    for (const u of [first, second])
      expect(
        Object.values(u?.approvals ?? {}).some(
          (ap) => ap.kind === 'merge' && ap.granted_by === 'policy:goal',
        ),
      ).toBe(true);

    // C starts only now, from the goal branch tip that holds both merges.
    const tipAfterAB = f.tip(goal.branch);
    await f.until(() => f.task(c).policy_ref !== null);
    expect(f.store.readRuntimeContext(c as never, 1)?.base_sha).toBe(tipAfterAB);

    const final = goal.final;
    await f.until(() => f.task(final).wait?.detail.code === 'merge');
    // SC-012: one merge commit per unit on the goal branch's first-parent history.
    const merges = g
      .sh(f.remote, 'rev-list', '--first-parent', '--merges', `${base}..refs/heads/${goal.branch}`)
      .split('\n')
      .filter((l) => l !== '');
    expect(merges).toHaveLength(3);

    // The goal's PR: from the goal branch into main, with the sections code builds (FR-087).
    const pr = f.github.prs.find((p) => p.head.ref === goal.branch);
    expect(pr?.base).toBe('main');
    expect(pr?.body).toContain('## Units');
    for (const k of ['a', 'b', 'c']) expect(pr?.body).toContain(`| \`${k}\` |`);
    for (const m of merges) expect(pr?.body).toContain(m);
    expect(f.workerRuns.filter((r) => r.endsWith(':final'))).toEqual([]);
    expect(f.store.goals.read(goal.goalId)?.status).toBe('running');

    // The owner merges the goal's PR on GitHub: the goal is done.
    f.github.prs.find((p) => p.head.ref === goal.branch);
    const n = pr?.number as number;
    await mergeOnGitHub(f, n);
    await f.until(() => f.store.goals.read(goal.goalId)?.status === 'done');
    expect(f.task(final).status).toBe('DONE');
  });
});

async function mergeOnGitHub(f: ReturnType<typeof setup>, n: number): Promise<void> {
  const pr = f.github.prs.find((p) => p.number === n);
  if (pr === undefined) throw new Error('no PR');
  const r = await f.github.request({
    method: 'PUT',
    path: `repos/acme/app/pulls/${n}/merge`,
    query: {},
    body: { sha: f.tip(pr.head.ref), merge_method: 'merge', commit_title: 'Merge goal' },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}
