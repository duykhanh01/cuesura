import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import { notifyDependents } from '../../../src/application/dependency.ts';
import { goalProgress } from '../../../src/application/goals.ts';
import { submit } from '../../../src/application/triage.ts';
import { LOOP_GUARD_ACTOR } from '../../../src/daemon/deputy.ts';
import type { GoalState } from '../../../src/domain/goal.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { injectEvents } from '../../../src/store/testing.ts';
import type { GoalTrigger } from '../../../src/domain/goal.ts';
import { buildTask } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { deputyDaemon, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import {
  confirmedGoal,
  goalCommand,
  goalPlan,
  planUnit,
  resultOf,
  type GoalView,
} from '../../support/goal.ts';

// 007 US3 edge cases, T084 (FR-076, R-29): a unit FAILED sends its goal to `replan`; the plan turn
// replaces the unit with a new task of the same key, sends a scope amendment, or hands the goal over.
// Its dependents and the integration task are not cancelled down the chain, even when the scheduler's
// dependency pass runs before the plan turn, and wake once the replacement is DONE.

const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

const turnOf = (input: HarnessInput): string => input.deputy_turn as string;
const PLAN = goalPlan([
  planUnit('a'),
  planUnit('b', { depends_on: ['a'] }),
  planUnit('c', { scope: ['src/c'] }),
]);

type Env = DeputyDaemon & { store: Store };

async function start(steps: Parameters<typeof deputyDaemon>[0]): Promise<Env> {
  const x = deputyDaemon(steps);
  live.push(x);
  const running = await x.sd.start();
  return { ...x, store: running.store };
}

const goalOf = (x: Env, id: string): GoalState => x.store.goals.read(id) as GoalState;
const task = (x: Env, id: string): TaskState => x.store.readTask(id as Uuid) as TaskState;

/** The goal confirmed and its branch created, so every unit not waiting on another is READY. */
async function runningGoal(x: Env): Promise<GoalView & { final: string }> {
  const g = await confirmedGoal(x.sd, PLAN);
  const r = x.store.goals.accept({
    goal_id: g.goal_id,
    dedup_key: `branch:${g.goal_id}`,
    now: x.sd.now,
    actor: 'system:goal',
    trigger: { kind: 'branch_created', sha: 'a'.repeat(40) },
  });
  expect(r.ok).toBe(true);
  for (const u of Object.values(g.units)) branchReady(x, u.task_id);
  return { ...g, final: goalOf(x, g.goal_id).final_task_id as string };
}

function branchReady(x: Env, id: string): void {
  submit(x.store, {
    task_id: id,
    dedup_key: `branch-ready:${id}`,
    trigger: { kind: 'goal_branch_ready' },
    now: x.sd.now,
    ids: [],
  });
}

function fail(x: Env, id: string, actor = 'deputy', reason = 'the export needs a new API'): void {
  injectEvents(x.store, id, [{ type: 'TaskFailed', revision: 1, actor, payload: { reason } }]);
}

/** A unit's task merged, as observation would end it. */
function done(x: Env, id: string): void {
  const s = task(x, id);
  injectEvents(x.store, id, [
    ...(s.status === 'PENDING'
      ? [{ type: 'TaskReady' as const, revision: s.revision, actor: 'system', payload: {} }]
      : []),
    { type: 'TaskResumed', revision: s.revision, actor: 'system', payload: { reason: 'test' } },
    { type: 'TaskCompleted', revision: s.revision, actor: 'system', payload: { reason: 'merged' } },
  ]);
}

/** One pass of the daemon's dependency and goal passes, in the order asked. */
function pass(x: Env, order: 'deps-first' | 'goal-first' = 'deps-first'): void {
  x.sd.now += 1_000;
  if (order === 'deps-first') {
    notifyDependents(x.store, x.sd.now);
    goalProgress(x.store, x.sd.now);
  } else {
    goalProgress(x.store, x.sd.now);
    notifyDependents(x.store, x.sd.now);
  }
}

async function planTurn(x: Env): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await x.deputy().round();
    await x.deputy().idle();
  }
}

/** A plan turn step sending `amend(goal)` as the deputy, then its handoff. */
function amendStep(
  x: () => Env,
  goalId: () => string,
  plan: (g: GoalState) => unknown,
  replies: GoalView[],
) {
  return {
    kind: 'turn_ended' as const,
    final_message: 'Replanned.',
    act: async (input: HarnessInput) => {
      const g = goalOf(x(), goalId());
      const r = await goalCommand(
        x().sd,
        'goal_amend',
        g.id,
        g.version,
        { plan: plan(g), plan_version: g.plan_version },
        { actor: 'deputy', turn: turnOf(input), reason: 'retry the failed unit' },
      );
      replies.push(resultOf(r));
      await x().asDeputy(turnOf(input), handoffBody('planned', 'process'));
    },
  };
}

describe('US3: a failed unit is replanned, not cascaded', () => {
  it('keeps dependents and the integration task alive while the scheduler runs before the plan turn', async () => {
    const x = await start([]);
    const g = await runningGoal(x);
    const [a, b, c] = ['a', 'b', 'c'].map((k) => g.units[k]?.task_id as string) as [
      string,
      string,
      string,
    ];
    expect(task(x, c).status).toBe('READY');
    fail(x, a);

    // The dependency pass runs first, the goal pass after: nothing is cancelled down the chain.
    pass(x, 'deps-first');
    pass(x, 'deps-first');
    expect(goalOf(x, g.goal_id)).toMatchObject({
      status: 'replan',
      replan_reason: 'unit_failed:a',
    });
    for (const id of [b, g.final]) {
      const s = task(x, id);
      expect(s.status).toBe('PENDING');
      expect(s.wait?.detail.code).toBe('dependency_pending');
      expect(s.wait?.detail['replan']).toEqual([a]);
    }
    // The independent unit is untouched.
    expect(task(x, c).status).toBe('READY');
    expect(x.store.readEvents(b as Uuid).some((e) => e.type === 'CancelRequested')).toBe(false);
  });

  it('replaces the unit with a new task of the same key; the dependents wake when it is DONE', async () => {
    let env: Env | null = null;
    let goalId = '';
    const replies: GoalView[] = [];
    env = await start([
      amendStep(
        () => env as Env,
        () => goalId,
        (g) => g.plan,
        replies,
      ),
    ]);
    const x = env;
    const g = await runningGoal(x);
    goalId = g.goal_id;
    const a = g.units['a']?.task_id as string;
    const b = g.units['b']?.task_id as string;
    fail(x, a);
    pass(x, 'goal-first');
    expect(goalOf(x, goalId).status).toBe('replan');

    await planTurn(x);
    expect(replies[0]).toMatchObject({ status: 'running', amendment: 'execution' });
    expect(replies[0]?.affected).toContain('a');
    const after = goalOf(x, goalId);
    const replacement = after.units['a']?.task_id as string;
    expect(replacement).not.toBe(a);
    expect(after.units['a']?.previous).toEqual([a]);
    expect(x.store.goals.ofTask(replacement)).toMatchObject({ unit_key: 'a', role: 'unit' });
    const r = task(x, replacement);
    expect(r.task.goal).toMatchObject({ id: goalId, unit_key: 'a', role: 'unit' });
    expect(r.task.acceptance).toEqual(task(x, a).task.acceptance);
    expect(r.task.description).toBe(task(x, a).task.description);
    expect(r.run.confirmation?.digest).toBe(r.run.proposal?.digest);
    // Nothing that depended on the failed task was rewritten or cancelled.
    expect(task(x, b).task.depends_on).toEqual([a]);
    expect(task(x, b).status).toBe('PENDING');

    pass(x);
    expect(goalOf(x, goalId).status).toBe('running');
    done(x, replacement);
    pass(x);
    expect(task(x, b).status).toBe('READY');
    // The integration task still waits for b and c, not for the failed task.
    const final = task(x, g.final);
    expect(final.status).toBe('PENDING');
    expect(Object.keys(final.wait?.detail['deps'] as object).sort()).toEqual(
      [b, g.units['c']?.task_id].sort(),
    );
    expect(final.wait?.detail['replan']).toBeUndefined();
  });

  it('sends a scope amendment that waits for the owner, then replaces the unit on confirmation', async () => {
    let env: Env | null = null;
    let goalId = '';
    const replies: GoalView[] = [];
    const reworded = (g: GoalState) => ({
      ...g.plan,
      units: g.plan?.units.map((u) =>
        u.key === 'a' ? { ...u, acceptance: ['a works with the new API'] } : u,
      ),
    });
    env = await start([
      amendStep(
        () => env as Env,
        () => goalId,
        reworded,
        replies,
      ),
    ]);
    const x = env;
    const g = await runningGoal(x);
    goalId = g.goal_id;
    const a = g.units['a']?.task_id as string;
    fail(x, a);
    pass(x);

    await planTurn(x);
    expect(replies[0]).toMatchObject({ status: 'amendment_pending', amendment: 'scope' });
    expect(goalOf(x, goalId).units['a']?.task_id).toBe(a);

    const pending = goalOf(x, goalId);
    const confirmed = resultOf(
      await goalCommand(x.sd, 'goal_confirm', goalId, pending.version, {
        plan_hash: pending.pending_amendment?.plan_hash,
      }),
    );
    expect(confirmed.status).toBe('running');
    const replacement = goalOf(x, goalId).units['a']?.task_id as string;
    expect(replacement).not.toBe(a);
    expect(task(x, replacement).task.acceptance).toEqual(['a works with the new API']);
    expect(task(x, g.units['b']?.task_id as string).status).toBe('PENDING');
  });

  it('hands the goal over: it stays in replan for the owner and nothing is replaced', async () => {
    let env: Env | null = null;
    env = await start([
      {
        kind: 'turn_ended',
        final_message: 'Needs the owner.',
        act: async (input) => {
          await (env as Env).asDeputy(turnOf(input), handoffBody('handover', 'spec'));
        },
      },
    ]);
    const x = env;
    const g = await runningGoal(x);
    const a = g.units['a']?.task_id as string;
    fail(x, a);
    pass(x);
    await planTurn(x);
    const [turn] = x.store.deputy.turnsOf({ goal_id: g.goal_id });
    expect(turn).toMatchObject({ kind: 'plan', state: 'handed_off' });
    expect(goalOf(x, g.goal_id)).toMatchObject({ status: 'replan' });
    expect(goalOf(x, g.goal_id).units['a']?.task_id).toBe(a);
    pass(x);
    expect(task(x, g.units['b']?.task_id as string).status).toBe('PENDING');
    expect(task(x, g.final).status).toBe('PENDING');

    // The owner cancels the goal: every unfinished task is cancelled now.
    const cancelled = await goalCommand(
      x.sd,
      'goal_cancel',
      g.goal_id,
      goalOf(x, g.goal_id).version,
      {
        reason: 'dropped',
      },
    );
    expect(cancelled.envelope.ok, JSON.stringify(cancelled.envelope)).toBe(true);
    for (const id of [g.units['b']?.task_id, g.units['c']?.task_id, g.final])
      expect(task(x, id as string).status).toBe('CANCELLED');
  });

  it('replacing a unit the loop guard ended is a scope amendment', async () => {
    let env: Env | null = null;
    let goalId = '';
    const replies: GoalView[] = [];
    env = await start([
      amendStep(
        () => env as Env,
        () => goalId,
        (g) => g.plan,
        replies,
      ),
    ]);
    const x = env;
    const g = await runningGoal(x);
    goalId = g.goal_id;
    const a = g.units['a']?.task_id as string;
    fail(
      x,
      a,
      LOOP_GUARD_ACTOR,
      'loop_guard: every action ran out on failure signature 0123456789ab',
    );
    pass(x);

    await planTurn(x);
    expect(replies[0]).toMatchObject({ status: 'amendment_pending', amendment: 'scope' });
    expect(replies[0]?.affected).toContain('a');
    expect(goalOf(x, goalId).units['a']?.task_id).toBe(a);
  });

  it('a goal that failed cancels its dependents as before', async () => {
    const x = await start([]);
    const g = await runningGoal(x);
    const a = g.units['a']?.task_id as string;
    fail(x, a);
    pass(x);
    const r = x.store.goals.accept({
      goal_id: g.goal_id,
      dedup_key: `fail:${g.goal_id}`,
      now: x.sd.now,
      actor: 'owner',
      trigger: { kind: 'fail', reason: 'gave up' },
    });
    expect(r.ok).toBe(true);
    pass(x);
    expect(task(x, g.units['b']?.task_id as string).cancellation).not.toBeNull();
  });

  it('makes the integration task wait on a unit a confirmed amendment added', async () => {
    const x = await start([]);
    const g = await runningGoal(x);
    const current = goalOf(x, g.goal_id);
    const plan = {
      ...current.plan,
      units: [...(current.plan?.units ?? []), planUnit('d', { scope: ['src/d'] })],
    };
    const amended = resultOf(
      await goalCommand(x.sd, 'goal_amend', g.goal_id, current.version, {
        plan,
        plan_version: current.plan_version,
      }),
    );
    expect(amended.status).toBe('amendment_pending');
    const pending = goalOf(x, g.goal_id);
    resultOf(
      await goalCommand(x.sd, 'goal_confirm', g.goal_id, pending.version, {
        plan_hash: pending.pending_amendment?.plan_hash,
      }),
    );
    const d = goalOf(x, g.goal_id).units['d']?.task_id as string;
    for (const k of ['a', 'b', 'c']) done(x, goalOf(x, g.goal_id).units[k]?.task_id as string);
    pass(x);
    const final = task(x, g.final);
    expect(final.status).toBe('PENDING');
    expect(Object.keys(final.wait?.detail['deps'] as object)).toEqual([d]);
  });
});

// FR-075, R-19: a unit whose failure signature was spent stays spent once the deputy fails it itself;
// retrying it needs the owner's confirmation, as when the loop guard ended it.
describe('US3: a unit the deputy failed on a spent signature', () => {
  const GOAL = '0192aaaa-0000-7000-8000-0000000000b1';
  const trial = { hypothesis: 'the mirror is back', expect: 'prepare passes' };

  function spendBackoff(d: StoreDriver, taskId: string): void {
    const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
    for (let i = 0; i < 12 && d.task(taskId).wait?.detail.code !== 'backoff_exhausted'; i++) {
      d.complete(taskId, d.pendingOne(taskId, 'prepare').id, 'succeeded', failed);
      d.now += 300_000;
      d.fire();
    }
    expect(d.task(taskId).wait?.detail.code).toBe('backoff_exhausted');
  }

  /** The unit spends its signature in a deputy turn, which then fails it with `task fail`. */
  async function spentFail(stale: boolean) {
    let fail: Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null = null;
    let refused: string | undefined;
    const t = buildTask({
      goal: { id: GOAL as Uuid, unit_key: 'a', role: 'unit', depends_on_units: [] },
    });
    const version = (store: Store) => store.readTask(t.id)?.version ?? -1;
    let env: (Env & { d: StoreDriver }) | null = null;
    const x0 = deputyDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          const x = env as Env & { d: StoreDriver };
          const turn = turnOf(input);
          const cont = await x.asDeputy(turn, {
            kind: 'task_continue',
            task_id: t.id,
            expected_version: version(x.store),
            payload: {},
            reason: 'transient network error',
            trial,
          });
          expect(cont.envelope.ok, JSON.stringify(cont.envelope)).toBe(true);
          spendBackoff(x.d, t.id);
          const m = await x.asDeputy(turn, {
            kind: 'task_message',
            task_id: t.id,
            expected_version: version(x.store),
            payload: { body: 'use the other mirror' },
            reason: 'another approach',
            trial,
          });
          expect(m.envelope.ok, JSON.stringify(m.envelope)).toBe(true);
          const p = await x.asDeputy(turn, {
            kind: 'task_pause',
            task_id: t.id,
            expected_version: version(x.store),
            payload: { reason: 'look again later' },
            reason: 'look again later',
          });
          refused = (p.envelope.error?.['details'] as { reason?: string } | undefined)?.reason;
          const failBody = (v: number) => ({
            kind: 'task_fail',
            task_id: t.id,
            expected_version: v,
            payload: { reason: 'every action ran out' },
            reason: 'every action ran out',
          });
          if (stale) {
            // Refused for its version after the guard saw the spent signature.
            const late = await x.asDeputy(turn, failBody(version(x.store) - 1));
            expect(late.envelope.ok).toBe(false);
            const note = await goalCommand(
              x.sd,
              'goal_note',
              GOAL,
              x.store.goals.read(GOAL)?.version ?? null,
              { text: 'the mirror is fixed now' },
            );
            expect(note.envelope.ok, JSON.stringify(note.envelope)).toBe(true);
          }
          fail = await x.asDeputy(turn, failBody(version(x.store)));
          await x.asDeputy(turn, handoffBody('handover', 'environment'));
        },
      },
    ]);
    live.push(x0);
    const plan = goalPlan([planUnit('a')]);
    let driver: StoreDriver | null = null;
    x0.sd.seed((d) => {
      driver = d;
      const triggers: GoalTrigger[] = [
        { kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} },
        { kind: 'propose', plan, plan_version: 0, plan_hash: 'sha256:p1' },
        { kind: 'confirm', plan_hash: 'sha256:p1', units: { a: t.id } },
      ];
      triggers.forEach((trigger, i) => {
        const r = d.store.goals.accept({
          goal_id: GOAL,
          dedup_key: `seed:${i}`,
          now: 1,
          actor: 'owner',
          trigger,
        });
        if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
      });
      createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 24 * 3_600_000 } });
      spendBackoff(d, t.id);
    });
    const running = await x0.sd.start();
    const d = new StoreDriver(running.store);
    d.now = (driver as StoreDriver | null)?.now ?? d.now;
    env = { ...x0, store: running.store, d };
    const x = env;
    await planTurn(x);

    return {
      x,
      t,
      fail: fail as Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null,
      refused: refused,
    };
  }

  it('is replaced only by a scope amendment the owner confirms', async () => {
    const { x, t, fail, refused } = await spentFail(false);
    expect(refused).toBe('signature_exhausted');
    expect(fail?.envelope.ok, JSON.stringify(fail)).toBe(true);
    expect(task(x, t.id).status).toBe('FAILED');
    expect(x.store.readEvents(t.id).findLast((e) => e.type === 'TaskFailed')?.actor).toBe('deputy');
    pass(x);
    const g = goalOf(x, GOAL);
    expect(g.status).toBe('replan');

    const amended = resultOf(
      await goalCommand(x.sd, 'goal_amend', GOAL, g.version, {
        plan: g.plan,
        plan_version: g.plan_version,
      }),
    );
    expect(amended).toMatchObject({ status: 'amendment_pending', amendment: 'scope' });
    expect(amended.affected).toContain('a');
    // No replacement before the owner confirms.
    expect(goalOf(x, GOAL).units['a']?.task_id).toBe(t.id);
    expect(x.store.goals.tasks(GOAL)).toHaveLength(1);

    const pending = goalOf(x, GOAL);
    resultOf(
      await goalCommand(x.sd, 'goal_confirm', GOAL, pending.version, {
        plan_hash: pending.pending_amendment?.plan_hash,
      }),
    );
    expect(goalOf(x, GOAL).units['a']?.task_id).not.toBe(t.id);
  });

  it('a refused fail leaves no mark: after new evidence a valid fail is retried by execution', async () => {
    const { x, t, fail } = await spentFail(true);
    expect(fail?.envelope.ok, JSON.stringify(fail)).toBe(true);
    expect(task(x, t.id).status).toBe('FAILED');
    pass(x);
    const g = goalOf(x, GOAL);
    expect(g.status).toBe('replan');
    const amended = resultOf(
      await goalCommand(x.sd, 'goal_amend', GOAL, g.version, {
        plan: g.plan,
        plan_version: g.plan_version,
      }),
    );
    expect(amended).toMatchObject({ status: 'running', amendment: 'execution' });
    expect(goalOf(x, GOAL).units['a']?.task_id).not.toBe(t.id);
  });
});
