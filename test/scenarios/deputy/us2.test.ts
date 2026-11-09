import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import { LOOP_GUARD_ACTOR } from '../../../src/daemon/deputy.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { buildTask } from '../../support/builders.ts';
import { deputyDaemon, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { goalCommand, goalPlan, planUnit } from '../../support/goal.ts';
import type { GoalTrigger } from '../../../src/domain/goal.ts';

// 007 US2, SC-009 (T043): a spent limit is a point to judge again; the daemon refuses the deputy's
// repeats without new evidence and ends a task whose every action ran out on its failure signature.

const HOUR = 3_600_000;
const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

/** Fails the prepare setup until its infra backoff is spent: the same failure each time. */
function spendBackoff(d: StoreDriver, taskId: string): void {
  const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
  for (let i = 0; i < 12 && d.task(taskId).wait?.detail.code !== 'backoff_exhausted'; i++) {
    d.complete(taskId, d.pendingOne(taskId, 'prepare').id, 'succeeded', failed);
    d.now += 300_000;
    d.fire();
  }
  expect(d.task(taskId).wait?.detail.code).toBe('backoff_exhausted');
}

const GOAL = '0192aaaa-0000-7000-8000-0000000000a1';

/** The goal of unit `a`, confirmed, with `taskId` as the unit's task. */
function seedGoal(store: Store, taskId: string): void {
  const plan = goalPlan([planUnit('a')]);
  const triggers: GoalTrigger[] = [
    { kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} },
    { kind: 'propose', plan, plan_version: 0, plan_hash: 'sha256:p1' },
    { kind: 'confirm', plan_hash: 'sha256:p1', units: { a: taskId } },
  ];
  triggers.forEach((trigger, i) => goalFact(store, trigger, `seed:${i}`));
}

function goalFact(store: Store, trigger: GoalTrigger, key: string, actor = 'owner'): void {
  const r = store.goals.accept({ goal_id: GOAL, dedup_key: key, now: 1, actor, trigger });
  if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
}

async function backoffDaemon(
  steps: Parameters<typeof deputyDaemon>[0],
  o: { readonly goal?: boolean } = {},
) {
  const x = deputyDaemon(steps);
  live.push(x);
  const t = buildTask(
    o.goal === true
      ? { goal: { id: GOAL as Uuid, unit_key: 'a', role: 'unit', depends_on_units: [] } }
      : {},
  );
  let driver: StoreDriver | null = null;
  x.sd.seed((d) => {
    driver = d;
    if (o.goal === true) seedGoal(d.store, t.id);
    createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 24 * HOUR } });
    spendBackoff(d, t.id);
  });
  const running = await x.sd.start();
  const d = new StoreDriver(running.store);
  d.now = (driver as StoreDriver | null)?.now ?? d.now;
  return { ...x, t, store: running.store, d };
}

const version = (store: Store, id: string): number => store.readTask(id as Uuid)?.version ?? -1;
const turnOf = (input: HarnessInput): string => input.deputy_turn as string;
const trial = { hypothesis: 'the mirror is back', expect: 'prepare passes' };

const continueBody = (store: Store, id: string) => ({
  kind: 'task_continue',
  task_id: id,
  expected_version: version(store, id),
  payload: {},
  reason: 'transient network error',
  trial,
});

const messageBody = (store: Store, id: string, body: string) => ({
  kind: 'task_message',
  task_id: id,
  expected_version: version(store, id),
  payload: { body },
  reason: 'another approach',
  trial,
});

const reasonOf = (r: { envelope: { error?: { details?: unknown } | null } }) =>
  (r.envelope.error?.details as { reason?: string } | undefined)?.reason;

async function runTurns(x: DeputyDaemon, turns = 1): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await x.deputy().round();
    await x.deputy().idle();
  }
}

describe('US2: the deputy breaks loops instead of retrying', () => {
  it('scenario 1: the turn sees the loop signals, the failure signature and the trial table', async () => {
    const x = await backoffDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          await x.asDeputy(turnOf(input), handoffBody('handover', 'environment'));
        },
      },
    ]);
    await runTurns(x);
    const text = x.harness.calls[0]?.context.text ?? '';
    for (const heading of [
      '## Loop signals',
      '## Trials on the current failure signature',
      '## Failure signature',
      '## Loop guard on this signature',
    ])
      expect(text).toContain(heading);
    expect(text).toContain('environment: backoff_exhausted');
    const [turn] = x.store.deputy.turnsOf({ task_id: x.t.id });
    expect(turn?.signature).toMatch(/^sha256:/);
    // `task explain` shows the same signature and signals (FR-040).
    for (const kind of ['task_explain', 'task_show']) {
      const r = await x.sd.query('owner', { kind, task_id: x.t.id });
      expect(r.envelope.data).toMatchObject({
        signature: turn?.signature,
        loop_signals: [{ kind: 'environment' }],
        waivers: [],
      });
    }
  });

  it('scenario 2: a second continue on the same signature without progress is refused', async () => {
    let second: Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null = null;
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          const first = await x.asDeputy(turnOf(input), continueBody(x.store, x.t.id));
          expect(first.envelope.ok, JSON.stringify(first.envelope)).toBe(true);
          spendBackoff(x.d, x.t.id);
          second = await x.asDeputy(turnOf(input), continueBody(x.store, x.t.id));
          await x.asDeputy(turnOf(input), handoffBody('handover', 'environment'));
        },
      },
    ]);
    await runTurns(x);
    expect(second).not.toBeNull();
    expect(reasonOf(second!)).toBe('repeat_without_evidence');
    expect(second!.envelope.error?.code).toBe('conflict');
  });

  it('scenario 3: a model already tried, or not allowed, is refused', async () => {
    let r: Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null = null;
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          r = await x.asDeputy(turnOf(input), {
            kind: 'task_amend_policy',
            task_id: x.t.id,
            expected_version: version(x.store, x.t.id),
            payload: { model: 'opus', reason: 'stronger', policy_hash: `sha256:${'0'.repeat(64)}` },
            reason: 'the model is not strong enough',
            trial,
          });
          await x.asDeputy(turnOf(input), handoffBody('handover', 'model'));
        },
      },
    ]);
    await runTurns(x);
    expect(reasonOf(r!)).toBe('action_exhausted');
  });

  it('scenario 4: a waiver is an extension and needs a hypothesis and a criterion', async () => {
    let r: Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null = null;
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          r = await x.asDeputy(turnOf(input), {
            kind: 'task_waive',
            task_id: x.t.id,
            expected_version: version(x.store, x.t.id),
            payload: { target: { kind: 'gate', key: 'unit' }, evidence: 'flaky' },
            reason: 'flaky gate',
          });
          await x.asDeputy(turnOf(input), handoffBody('handover', 'environment'));
        },
      },
    ]);
    await runTurns(x);
    expect(r!.envelope.error?.code).toBe('invalid_command');
  });

  it('scenario 5: every action spent and no fail or handover: the loop guard ends the task', async () => {
    let refused: Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null = null;
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          const turn = turnOf(input);
          expect((await x.asDeputy(turn, continueBody(x.store, x.t.id))).envelope.ok).toBe(true);
          spendBackoff(x.d, x.t.id);
          const m = await x.asDeputy(turn, messageBody(x.store, x.t.id, 'use the other mirror'));
          expect(m.envelope.ok, JSON.stringify(m.envelope)).toBe(true);
          refused = await x.asDeputy(turn, {
            kind: 'task_pause',
            task_id: x.t.id,
            expected_version: version(x.store, x.t.id),
            payload: { reason: 'look again later' },
            reason: 'look again later',
          });
          await x.asDeputy(turn, handoffBody('continue', 'environment'));
        },
      },
    ]);
    await runTurns(x);
    expect(reasonOf(refused!)).toBe('signature_exhausted');
    const s = x.store.readTask(x.t.id);
    expect(s?.status).toBe('FAILED');
    const failed = x.store.readEvents(x.t.id).findLast((e) => e.type === 'TaskFailed');
    expect(failed?.actor).toBe(LOOP_GUARD_ACTOR);
    expect(x.store.deputy.turnsOf({ task_id: x.t.id })[0]?.state).toBe('done');
  });

  it("scenario 6: the owner's new instruction is new evidence for the same action", async () => {
    let again: Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null = null;
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          const turn = turnOf(input);
          expect((await x.asDeputy(turn, continueBody(x.store, x.t.id))).envelope.ok).toBe(true);
          spendBackoff(x.d, x.t.id);
          const o = await x.asOwner({
            kind: 'task_message',
            task_id: x.t.id,
            expected_version: version(x.store, x.t.id),
            payload: { body: 'the mirror is fixed now, try again' },
          });
          expect(o.envelope.ok, JSON.stringify(o.envelope)).toBe(true);
          again = await x.asDeputy(turn, continueBody(x.store, x.t.id));
          await x.asDeputy(turn, handoffBody('continue', 'environment'));
        },
      },
    ]);
    await runTurns(x);
    expect(again!.envelope.ok, JSON.stringify(again!.envelope)).toBe(true);
  });

  it("scenario 6 on a goal: the owner's directive on the goal is new evidence for the unit", async () => {
    let again: Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null = null;
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon(
      [
        {
          kind: 'turn_ended',
          act: async (input) => {
            const turn = turnOf(input);
            expect((await x.asDeputy(turn, continueBody(x.store, x.t.id))).envelope.ok).toBe(true);
            spendBackoff(x.d, x.t.id);
            const note = await goalCommand(
              x.sd,
              'goal_note',
              GOAL,
              x.store.goals.read(GOAL)?.version ?? null,
              { text: 'the mirror is fixed now' },
            );
            expect(note.envelope.ok, JSON.stringify(note.envelope)).toBe(true);
            again = await x.asDeputy(turn, continueBody(x.store, x.t.id));
            await x.asDeputy(turn, handoffBody('continue', 'environment'));
          },
        },
      ],
      { goal: true },
    );
    await runTurns(x);
    expect(again!.envelope.ok, JSON.stringify(again!.envelope)).toBe(true);
  });

  it('a plan amendment the owner confirms on the unit is new evidence; the loop guard does not end the task', async () => {
    let paused: Awaited<ReturnType<DeputyDaemon['asDeputy']>> | null = null;
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon(
      [
        {
          kind: 'turn_ended',
          act: async (input) => {
            const turn = turnOf(input);
            expect((await x.asDeputy(turn, continueBody(x.store, x.t.id))).envelope.ok).toBe(true);
            spendBackoff(x.d, x.t.id);
            const m = await x.asDeputy(turn, messageBody(x.store, x.t.id, 'use the other mirror'));
            expect(m.envelope.ok, JSON.stringify(m.envelope)).toBe(true);
            // Every action is spent here (scenario 5); the owner then confirms a new plan for unit a.
            const plan = goalPlan([planUnit('a', { instructions: 'use the internal mirror' })]);
            goalFact(
              x.store,
              {
                kind: 'amend',
                plan,
                plan_version: 1,
                plan_hash: 'sha256:p2',
                amendment: 'scope',
                affected: ['a'],
              },
              'amend',
            );
            goalFact(x.store, { kind: 'confirm', plan_hash: 'sha256:p2', units: {} }, 'confirm');
            paused = await x.asDeputy(turn, {
              kind: 'task_continue',
              task_id: x.t.id,
              expected_version: version(x.store, x.t.id),
              payload: {},
              reason: 'the plan now names the internal mirror',
              trial: { hypothesis: 'the internal mirror works', expect: 'prepare passes' },
            });
            await x.asDeputy(turn, handoffBody('continue', 'environment'));
          },
        },
      ],
      { goal: true },
    );
    await runTurns(x);
    expect(paused!.envelope.ok, JSON.stringify(paused!.envelope)).toBe(true);
    expect(x.store.readTask(x.t.id)?.status).not.toBe('FAILED');
    expect(
      x.store
        .readEvents(x.t.id)
        .some((e) => e.type === 'TaskFailed' && e.actor === LOOP_GUARD_ACTOR),
    ).toBe(false);
  });
});
