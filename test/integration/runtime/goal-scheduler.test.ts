import { describe, expect, it } from 'vitest';
import type { GitPort } from '../../../src/adapters/ports.ts';
import { effectiveScopes } from '../../../src/application/scope.ts';
import { startTask, type StartResult } from '../../../src/application/start.ts';
import { Scheduler } from '../../../src/daemon/scheduler.ts';
import type { GoalTrigger, Plan } from '../../../src/domain/goal.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { deputyTurn } from '../../support/deputy.ts';
import { goalPlan, planUnit } from '../../support/goal.ts';
import {
  configuredSelection,
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';
import { createGrantStart, proposeAndConfirm } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 US4, SC-011 (T082, FR-090, FR-091): the scheduler dispatches the units of every goal by code alone.
// Units of two goals with scopes apart run side by side up to the slots; a unit whose declared scope
// overlaps a running one waits under the project-wide scope guard (#240), as any task does; a deputy
// turn in progress changes nothing it decides.

const tempDir = useTempDir('cusr-goal-scheduler-');
const noGit: GitPort = { run: () => Promise.resolve({ kind: 'spawn_failed', message: 'no git' }) };

type Unit = { key: string; n: number; scope: string[] };
type GoalSeed = { id: string; units: Unit[] };

function setup(concurrency: number) {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  let ids = 9_000;
  const start = (taskId: string): Promise<StartResult> =>
    startTask(
      {
        store: d.store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () =>
          Promise.resolve({ user: userConfig(), packs: PACKS, manifests: MANIFESTS }),
        docs: {
          prompts: (names) =>
            Promise.resolve(names.map((name) => ({ name, content: `# ${name}\n` }))),
          attachments: () => Promise.resolve([]),
        },
        now: () => d.now,
        newId: () => uuidOf(ids++),
      },
      taskId,
    );
  const scheduler = new Scheduler({
    store: d.store,
    clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
    start,
    newId: () => uuidOf(ids++),
    concurrency,
    scopes: (taskIds) =>
      effectiveScopes(
        { store: d.store, git: noGit, projectPath: () => Promise.resolve(null) },
        taskIds,
      ),
  });
  return { d, scheduler };
}

const unitTaskOf = (goalId: string, u: Unit): CanonicalTask =>
  buildTask({
    id: uuidOf(u.n),
    source_key: `goal:${goalId}:${u.key}:${uuidOf(u.n)}`,
    scope: u.scope,
    goal: { id: goalId as Uuid, unit_key: u.key, role: 'unit', depends_on_units: [] },
  });

/** A confirmed goal whose units are tasks with confirmed run configs, ready to queue. */
async function seedGoal(d: StoreDriver, g: GoalSeed): Promise<CanonicalTask[]> {
  const plan: Plan = goalPlan(g.units.map((u) => planUnit(u.key, { scope: u.scope })));
  const triggers: GoalTrigger[] = [
    { kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} },
    { kind: 'propose', plan, plan_version: 0, plan_hash: `sha256:${g.id}` },
    {
      kind: 'confirm',
      plan_hash: `sha256:${g.id}`,
      units: Object.fromEntries(g.units.map((u) => [u.key, uuidOf(u.n)])),
    },
  ];
  triggers.forEach((trigger, i) => {
    const r = d.store.goals.accept({
      goal_id: g.id,
      dedup_key: `${g.id}:${i}`,
      now: d.now,
      actor: 'owner',
      trigger,
    });
    if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
  });
  const tasks = g.units.map((u) => unitTaskOf(g.id, u));
  for (const t of tasks) {
    d.must(t.id, { kind: 'create_task', task: t });
    proposeAndConfirm(d, t, await configuredSelection(t, 'full-review'));
  }
  return tasks;
}

const G1 = '0192bbbb-0000-7000-8000-0000000000a1';
const G2 = '0192bbbb-0000-7000-8000-0000000000a2';

describe('scheduler across goals (SC-011)', () => {
  it('runs the units of two goals with scopes apart side by side up to the slots', async () => {
    const { d, scheduler } = setup(3);
    const [a1, a2] = await seedGoal(d, {
      id: G1,
      units: [
        { key: 'a1', n: 1, scope: ['src/a1'] },
        { key: 'a2', n: 2, scope: ['src/a2'] },
      ],
    });
    const [b1, b2] = await seedGoal(d, {
      id: G2,
      units: [
        { key: 'b1', n: 3, scope: ['src/b1'] },
        { key: 'b2', n: 4, scope: ['src/b2'] },
      ],
    });
    const r = await scheduler.tick();
    expect(r.granted).toEqual([a1?.id, a2?.id, b1?.id]);
    expect(r.passed_over).toEqual([]);
    expect(r.started.map((s) => s.task_id)).toEqual([a1?.id, a2?.id, b1?.id]);
    // The fourth waits for a slot, not for its scope or its goal.
    expect(d.task(b2?.id as string).execution).toMatchObject({
      holding: null,
      request: { group: 'fresh' },
    });
  });

  it('keeps a unit whose scope overlaps a running unit of another goal waiting under the guard', async () => {
    const { d, scheduler } = setup(3);
    const [a1, a2] = await seedGoal(d, {
      id: G1,
      units: [
        { key: 'a1', n: 1, scope: ['src/shared'] },
        { key: 'a2', n: 2, scope: ['src/a2'] },
      ],
    });
    const [b1, b2] = await seedGoal(d, {
      id: G2,
      units: [
        { key: 'b1', n: 3, scope: ['src/shared/report.ts'] },
        { key: 'b2', n: 4, scope: ['src/b2'] },
      ],
    });
    const r = await scheduler.tick();
    expect(r.granted).toEqual([a1?.id, a2?.id, b2?.id]);
    expect(r.passed_over).toEqual([b1?.id]);
    // No new wait: it stays queued and is granted once the overlapping unit holds no slot.
    expect(d.task(b1?.id as string).status).toBe('READY');
    expect(d.task(b1?.id as string).wait).toBeNull();
  });

  it('decides the same with a deputy turn in progress', async () => {
    const run = async (turns: boolean) => {
      const { d, scheduler } = setup(2);
      // A started unit of G1 waits for a person and keeps its slot as a reservation.
      const held = unitTaskOf(G1, { key: 'a0', n: 10, scope: ['src/a0'] });
      createGrantStart(d, held, 'full-review', {}, {}, 2);
      d.complete(held.id, d.pendingOne(held.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      d.complete(
        held.id,
        d.pendingOne(held.id, 'start_agent').id,
        'succeeded',
        agentData('needs_input', { questions: ['Postgres or SQLite?'] }),
      );
      await seedGoal(d, {
        id: G2,
        units: [
          { key: 'b1', n: 3, scope: ['src/b1'] },
          { key: 'b2', n: 4, scope: ['src/a0/x.ts'] },
          { key: 'b3', n: 5, scope: ['src/b3'] },
        ],
      });
      if (turns) {
        expect(
          d.store.deputy.startTurn(deputyTurn({ task_id: held.id, goal_id: G1, now: d.now })).ok,
        ).toBe(true);
        expect(
          d.store.deputy.startTurn(
            deputyTurn({
              turn_id: uuidOf(950),
              attempt_id: uuidOf(951),
              task_id: null,
              goal_id: G2,
              kind: 'plan',
              now: d.now,
            }),
          ).ok,
        ).toBe(true);
      }
      const r = await scheduler.tick();
      return { granted: r.granted, lent: r.lent, passed_over: r.passed_over };
    };
    const without = await run(false);
    expect(without.granted.length + without.lent.length).toBe(2);
    expect(await run(true)).toEqual(without);
  });
});
