import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import { deputyDaemon, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import { confirmedGoal, goalCommand, goalPlan, planUnit, resultOf } from '../../support/goal.ts';

// 007 US6 (goal part), T058: the owner's revise wins over a plan turn in flight, and two amendments on
// one plan version are taken once (FR-054, FR-058).

const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

const turnOf = (input: HarnessInput): string => input.deputy_turn as string;

async function rounds(x: DeputyDaemon, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    await x.deputy().round();
    await x.deputy().idle();
  }
}

describe('US6: owner and deputy on one goal', () => {
  it('a revise during a plan turn makes its proposal stale and opens a new plan turn (scenario 2)', async () => {
    let goalId = '';
    const outcomes: unknown[] = [];
    const x: DeputyDaemon = deputyDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          const g = x.sd.daemon?.store.goals.read(goalId);
          const revised = await goalCommand(x.sd, 'goal_revise', goalId, g?.version ?? 0, {
            request: 'Export JSON lines instead',
          });
          expect(revised.envelope.ok, JSON.stringify(revised.envelope)).toBe(true);
          const after = x.sd.daemon?.store.goals.read(goalId);
          const r = await goalCommand(
            x.sd,
            'goal_propose',
            goalId,
            after?.version ?? 0,
            { plan: goalPlan([planUnit('a')]), plan_version: 0 },
            { actor: 'deputy', turn: turnOf(input), reason: 'one unit' },
          );
          outcomes.push(r.envelope.error);
          await x.asDeputy(turnOf(input), handoffBody('planned', 'none'));
        },
      },
      {
        kind: 'turn_ended',
        act: async (input) => {
          const g = x.sd.daemon?.store.goals.read(goalId);
          const r = await goalCommand(
            x.sd,
            'goal_propose',
            goalId,
            g?.version ?? 0,
            { plan: goalPlan([planUnit('a')]), plan_version: g?.plan_version ?? 0 },
            { actor: 'deputy', turn: turnOf(input), reason: 'one unit, JSON lines' },
          );
          expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
          await x.asDeputy(turnOf(input), handoffBody('planned', 'none'));
        },
      },
    ]);
    live.push(x);
    const running = await x.sd.start();
    goalId = resultOf(
      await goalCommand(x.sd, 'goal_add', null, null, {
        request: 'Export CSV',
        base_branch: 'main',
      }),
    ).goal_id;
    await rounds(x);

    expect(outcomes).toMatchObject([
      { code: 'conflict', details: { reason: 'plan_version', current: 1 } },
    ]);
    expect(x.harness.calls).toHaveLength(2);
    expect(x.harness.calls[1]?.context.text).toContain('Export JSON lines instead');
    const turns = running.store.deputy.turnsOf({ goal_id: goalId });
    expect(turns.map((t) => [t.kind, t.state])).toEqual([
      ['plan', 'done'],
      ['plan', 'done'],
    ]);
    expect(running.store.goals.read(goalId)).toMatchObject({
      status: 'awaiting_confirm',
      plan_version: 2,
    });
  });

  it('takes one of two amendments on the same plan version (scenario 3)', async () => {
    const x = deputyDaemon([], { setting: null });
    live.push(x);
    await x.sd.start();
    const plan = goalPlan([planUnit('a'), planUnit('b')]);
    const g = await confirmedGoal(x.sd, plan);
    const one = {
      ...plan,
      units: plan.units.map((u) => (u.key === 'a' ? { ...u, instructions: 'one' } : u)),
    };
    const two = {
      ...plan,
      units: plan.units.map((u) => (u.key === 'b' ? { ...u, instructions: 'two' } : u)),
    };
    const first = resultOf(
      await goalCommand(x.sd, 'goal_amend', g.goal_id, g.version, { plan: one, plan_version: 1 }),
    );
    expect(first.plan_version).toBe(2);
    // Same plan version, sent against the goal as it is now: the plan it was built on is gone.
    const second = await goalCommand(x.sd, 'goal_amend', g.goal_id, first.version, {
      plan: two,
      plan_version: 1,
    });
    expect(second.envelope.error).toMatchObject({
      code: 'conflict',
      details: { reason: 'plan_version', current: 2 },
    });
    // And sent against the version both read: stale.
    const third = await goalCommand(x.sd, 'goal_amend', g.goal_id, g.version, {
      plan: two,
      plan_version: 1,
    });
    expect(third.envelope.error).toMatchObject({ code: 'conflict' });
  });
});
