import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import type { Plan } from '../../../src/domain/goal.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { deputyDaemon, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import {
  confirmedGoal,
  goalCommand,
  goalPlan,
  planUnit,
  resultOf,
  type GoalView,
} from '../../support/goal.ts';

// 007 US3 (plan part), T056: a goal is planned by a deputy turn, confirmed once by hash, and changed by
// classified amendments.

const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

const turnOf = (input: HarnessInput): string => input.deputy_turn as string;
const REQUEST = 'Add a CSV export to the report.\nKeep the JSON one.\n';

async function start(steps: Parameters<typeof deputyDaemon>[0], o: { deputy?: boolean } = {}) {
  const x = deputyDaemon(steps, o.deputy === false ? { setting: null } : {});
  live.push(x);
  const running = await x.sd.start();
  return { ...x, store: running.store };
}

async function rounds(x: DeputyDaemon): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await x.deputy().round();
    await x.deputy().idle();
  }
}

async function peek(x: DeputyDaemon): Promise<{ task_id: string; code: string }[]> {
  const r = await x.sd.query('assistant', { kind: 'attention_peek' });
  return (r.envelope.data?.['tasks'] ?? []) as { task_id: string; code: string }[];
}

async function register(x: DeputyDaemon, session: string): Promise<void> {
  const r = await x.sd.query('assistant', { kind: 'assistant_register', session, take: true });
  expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
}

async function show(x: DeputyDaemon, id: string): Promise<Record<string, unknown>> {
  const r = await x.sd.query('assistant', { kind: 'goal_show', goal_id: id });
  expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
  return r.envelope.data as Record<string, unknown>;
}

const goalOf = (store: Store, id: string) => store.goals.read(id);
const task = (store: Store, id: string) => store.readTask(id as Uuid);

describe('US3: goal and plan', () => {
  it('plans in a deputy turn, shows the plan, and tells the lease holder it waits (scenarios 1, 2)', async () => {
    const plan = goalPlan([
      planUnit('model'),
      planUnit('cli', { depends_on: ['model'] }),
      planUnit('docs', { scope: ['src/docs'] }),
    ]);
    let goalId = '';
    const x: Awaited<ReturnType<typeof start>> = await start([
      {
        kind: 'turn_ended',
        final_message: 'Planned in three units.',
        act: async (input) => {
          const g = goalOf(x.store, goalId);
          const r = await goalCommand(
            x.sd,
            'goal_propose',
            goalId,
            g?.version ?? 0,
            { plan, plan_version: 0 },
            {
              actor: 'deputy',
              turn: turnOf(input),
              reason: 'three units, docs independent',
            },
          );
          expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
          await x.asDeputy(turnOf(input), handoffBody('planned', 'none'));
        },
      },
    ]);
    await register(x, 'S1');
    const added = resultOf(
      await goalCommand(
        x.sd,
        'goal_add',
        null,
        null,
        { request: REQUEST, base_branch: 'main' },
        {
          actor: 'assistant',
          lease: 'S1',
        },
      ),
    );
    goalId = added.goal_id;
    expect(added.status).toBe('planning');
    // The deputy may still plan it: nobody is woken for it.
    expect(await peek(x)).toEqual([]);
    await rounds(x);

    expect(x.harness.calls).toHaveLength(1);
    expect(x.harness.calls[0]?.context.text).toContain(REQUEST.trimEnd());
    const [turn] = x.store.deputy.turnsOf({ goal_id: goalId });
    expect(turn).toMatchObject({ kind: 'plan', task_id: null, state: 'done' });
    const g = goalOf(x.store, goalId);
    expect(g?.request).toBe(REQUEST);
    expect(g?.status).toBe('awaiting_confirm');
    const shown = await show(x, goalId);
    expect(shown).toMatchObject({
      status: 'awaiting_confirm',
      plan_version: 1,
      parallel_groups: [['docs', 'model'], ['cli']],
    });
    expect(shown['plan_hash']).toBe(g?.plan_hash);
    expect((shown['plan'] as Plan).units.map((u) => u.acceptance)).toEqual(
      plan.units.map((u) => u.acceptance),
    );
    expect(await peek(x)).toEqual([
      { task_id: goalId, code: 'goal_plan_awaiting_confirm', undelivered: true },
    ]);
  });

  it('turns every unit into a confirmed task; one unit gets no goal branch (scenarios 3, 8)', async () => {
    const x = await start([], { deputy: false });
    const g = await confirmedGoal(
      x.sd,
      goalPlan([planUnit('a'), planUnit('b', { depends_on: ['a'] })]),
    );
    expect(g.status).toBe('running');
    for (const key of ['a', 'b']) {
      const s = task(x.store, g.units[key]?.task_id as string);
      // The plan's confirmation is the intake's: nothing waits for another one.
      expect(s?.needs_confirmation === false || s?.confirmed === true).toBe(true);
      expect(['READY', 'PENDING']).toContain(s?.status);
      expect(s?.wait?.detail.code ?? null).not.toBe('needs_confirmation');
      expect(s?.run.confirmation?.digest).toBe(s?.run.proposal?.digest);
      // Lát E: with several units each unit targets the goal branch and waits for it to exist.
      const branch = goalOf(x.store, g.goal_id)?.branch as string;
      expect(branch).toMatch(/^goal\/[0-9a-f]{8}-export-the-report-as-csv$/);
      expect(s?.task.goal).toEqual({
        id: g.goal_id,
        unit_key: key,
        role: 'unit',
        depends_on_units: key === 'b' ? ['a'] : [],
        branch,
      });
      expect(s?.task.base_branch).toBe(branch);
      expect(s?.wait?.detail['goal_branch']).toBe(branch);
    }
    const stored0 = goalOf(x.store, g.goal_id);
    const final = task(x.store, stored0?.final_task_id as string);
    expect(final?.task.goal).toMatchObject({ role: 'final', branch: stored0?.branch });
    expect(final?.task.base_branch).toBe('main');
    expect([...(final?.task.depends_on ?? [])].sort()).toEqual(
      [g.units['a']?.task_id, g.units['b']?.task_id].sort(),
    );
    expect(task(x.store, g.units['b']?.task_id as string)?.task.depends_on).toEqual([
      g.units['a']?.task_id,
    ]);

    const one = await confirmedGoal(x.sd, goalPlan([planUnit('only', { scope: undefined })]));
    const stored = goalOf(x.store, one.goal_id);
    expect(stored?.branch).toBeNull();
    expect(stored?.final_task_id).toBeNull();
    expect(x.store.goals.tasks(one.goal_id)).toHaveLength(1);
    expect(task(x.store, one.units['only']?.task_id as string)?.task.base_branch).toBe('main');
  });

  it('refuses a confirmation by a hash the plan no longer has (scenario 4)', async () => {
    const x = await start([], { deputy: false });
    const added = resultOf(
      await goalCommand(x.sd, 'goal_add', null, null, { request: 'r', base_branch: 'main' }),
    );
    const first = resultOf(
      await goalCommand(x.sd, 'goal_propose', added.goal_id, added.version, {
        plan: goalPlan([planUnit('a')]),
        plan_version: 0,
      }),
    );
    const second = resultOf(
      await goalCommand(x.sd, 'goal_propose', added.goal_id, first.version, {
        plan: goalPlan([planUnit('a'), planUnit('b')]),
        plan_version: 1,
      }),
    );
    const r = await goalCommand(x.sd, 'goal_confirm', added.goal_id, second.version, {
      plan_hash: first.plan_hash,
    });
    expect(r.envelope.error).toMatchObject({ code: 'conflict' });
    expect(r.envelope.error?.['details']).toMatchObject({
      reason: 'plan_hash',
      current: second.plan_hash,
    });
  });

  it('holds what a scope amendment touches and applies an execution one at once (scenario 9)', async () => {
    const x = await start([], { deputy: false });
    const plan = goalPlan([planUnit('a'), planUnit('b')]);
    const g = await confirmedGoal(x.sd, plan);
    const a = g.units['a']?.task_id as string;
    const b = g.units['b']?.task_id as string;
    const describedA = {
      ...plan,
      units: plan.units.map((u) =>
        u.key === 'a' ? { ...u, description: 'Export JSON instead' } : u,
      ),
    };
    const scope = resultOf(
      await goalCommand(
        x.sd,
        'goal_amend',
        g.goal_id,
        g.version,
        { plan: describedA, plan_version: 1 },
        { reason: 'r' },
      ),
    );
    expect(scope).toMatchObject({
      status: 'amendment_pending',
      amendment: 'scope',
      affected: ['a'],
    });
    expect(task(x.store, a)?.pause?.hold).toBe('plan_amendment');
    expect(task(x.store, b)?.pause ?? null).toBeNull();
    // A second amendment on the old plan version is refused.
    const late = await goalCommand(x.sd, 'goal_amend', g.goal_id, scope.version, {
      plan: describedA,
      plan_version: 1,
    });
    expect(late.envelope.ok).toBe(false);

    const confirmed = resultOf(
      await goalCommand(x.sd, 'goal_confirm', g.goal_id, scope.version, {
        plan_hash: (scope.pending_amendment as NonNullable<GoalView['pending_amendment']>)
          .plan_hash,
      }),
    );
    expect(confirmed.status).toBe('running');
    expect(task(x.store, a)?.pause ?? null).toBeNull();
    expect(goalOf(x.store, g.goal_id)?.plan?.units[0]?.description).toBe('Export JSON instead');

    const current = goalOf(x.store, g.goal_id);
    const instructedB = {
      ...describedA,
      units: describedA.units.map((u) =>
        u.key === 'b' ? { ...u, instructions: 'Reuse the JSON writer' } : u,
      ),
    };
    const exec = resultOf(
      await goalCommand(x.sd, 'goal_amend', g.goal_id, current?.version ?? 0, {
        plan: instructedB,
        plan_version: current?.plan_version ?? 0,
      }),
    );
    expect(exec).toMatchObject({ status: 'running', amendment: 'execution', affected: ['b'] });
    const sb = task(x.store, b);
    expect(sb?.revision).toBe(2);
    expect(sb?.task.description).toContain('Reuse the JSON writer');
    expect(sb?.run.proposal?.selection.revision).toBe(2);
    expect(sb?.run.confirmation?.digest).toBe(sb?.run.proposal?.digest);
  });

  it('gives the units the confirmed scope amendment, and checks its run configs (FR-075)', async () => {
    const x = await start([], { deputy: false });
    const plan = goalPlan([planUnit('a'), planUnit('b')]);
    const g = await confirmedGoal(x.sd, plan);
    const a = g.units['a']?.task_id as string;
    const forbidden = {
      ...plan,
      units: plan.units.map((u) =>
        u.key === 'a'
          ? {
              ...u,
              acceptance: ['other'],
              run_config: {
                ...u.run_config,
                worker: { ...u.run_config.worker, model: 'forbidden-model' },
              },
            }
          : u,
      ),
    };
    const refused = await goalCommand(x.sd, 'goal_amend', g.goal_id, g.version, {
      plan: forbidden,
      plan_version: 1,
    });
    expect(refused.envelope.error).toMatchObject({ code: 'plan_invalid' });
    expect(
      (refused.envelope.error?.['details'] as { issues: { code: string }[] }).issues,
    ).toMatchObject([{ code: 'run_config', unit: 'a' }]);

    const amended = {
      ...plan,
      units: plan.units.map((u) =>
        u.key === 'a'
          ? { ...u, description: 'Export JSON instead', acceptance: ['JSON export works'] }
          : u,
      ),
    };
    const scope = resultOf(
      await goalCommand(x.sd, 'goal_amend', g.goal_id, g.version, {
        plan: amended,
        plan_version: 1,
      }),
    );
    expect(task(x.store, a)?.task.acceptance).toEqual(['a works']);
    resultOf(
      await goalCommand(x.sd, 'goal_confirm', g.goal_id, scope.version, {
        plan_hash: scope.pending_amendment?.plan_hash,
      }),
    );
    const sa = task(x.store, a);
    expect(sa?.revision).toBe(2);
    expect(sa?.task.description).toBe('Export JSON instead');
    expect(sa?.task.acceptance).toEqual(['JSON export works']);
    expect(sa?.run.proposal?.selection.revision).toBe(2);
    expect(sa?.run.confirmation?.digest).toBe(sa?.run.proposal?.digest);
    expect(sa?.pause ?? null).toBeNull();
  });

  it('applies a change of run config alone to a unit not started yet (FR-075)', async () => {
    const x = await start([], { deputy: false });
    const plan = goalPlan([planUnit('a')]);
    const g = await confirmedGoal(x.sd, plan);
    const a = g.units['a']?.task_id as string;
    expect(task(x.store, a)?.run.proposal?.selection.mode).toBe('direct-pr');
    const reviewed = {
      ...plan,
      units: plan.units.map((u) => ({
        ...u,
        run_config: {
          ...u.run_config,
          mode: 'full-review' as const,
          reviewer: { harness: 'codex', model: 'sol', effort: 'medium' as const },
        },
      })),
    };
    const r = await goalCommand(x.sd, 'goal_amend', g.goal_id, g.version, {
      plan: reviewed,
      plan_version: 1,
    });
    expect(resultOf(r)).toMatchObject({ amendment: 'execution', affected: ['a'] });
    const sa = task(x.store, a);
    expect(sa?.revision).toBe(1);
    expect(sa?.run.proposal?.selection.mode).toBe('full-review');
    expect(sa?.run.confirmation?.digest).toBe(sa?.run.proposal?.digest);
  });
});
