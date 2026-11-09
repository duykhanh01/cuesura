import { describe, expect, it } from 'vitest';
import type { GitPort } from '../../../src/adapters/ports.ts';
import { effectiveScopes } from '../../../src/application/scope.ts';
import { startTask, type StartResult } from '../../../src/application/start.ts';
import { Scheduler, type SchedulerDeps } from '../../../src/daemon/scheduler.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
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

// A task that never started takes no slot and no loan while its scope shares files with a task
// holding one (issue #240, FR-044.08).

const tempDir = useTempDir('cusr-scope-guard-');

// No task here has a branch, so the reader never needs git: scopes are what the tasks declared.
const noGit: GitPort = { run: () => Promise.resolve({ kind: 'spawn_failed', message: 'no git' }) };

let ids = 9_000;
function schedulerFor(
  d: StoreDriver,
  opts: { concurrency?: number; reservationMs?: number; scopes?: SchedulerDeps['scopes'] } = {},
): Scheduler {
  const realStart = (taskId: string): Promise<StartResult> =>
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
  return new Scheduler({
    store: d.store,
    clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
    start: realStart,
    newId: () => uuidOf(ids++),
    scopes:
      opts.scopes ??
      ((taskIds) =>
        effectiveScopes(
          { store: d.store, git: noGit, projectPath: () => Promise.resolve(null) },
          taskIds,
        )),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    ...(opts.reservationMs === undefined ? {} : { reservationMs: opts.reservationMs }),
  });
}

function setup(
  opts: { concurrency?: number; reservationMs?: number; scopes?: SchedulerDeps['scopes'] } = {},
) {
  const path = dbPath(tempDir());
  const d = new StoreDriver(openFileStoreForTest(path));
  return { d, path, scheduler: schedulerFor(d, opts) };
}

const task = (n: number, over: Partial<CanonicalTask> = {}) =>
  buildTask({ id: uuidOf(n), source_key: `cli:${n}`, ...over });

async function confirmed(d: StoreDriver, t: CanonicalTask): Promise<void> {
  d.must(t.id, { kind: 'create_task', task: t });
  proposeAndConfirm(d, t, await configuredSelection(t, 'full-review'));
}

/** Started on a slot of its own, then waits for a person: it keeps the slot as a reservation. */
function startedAndAsking(d: StoreDriver, t: CanonicalTask, capacity = 1): string {
  createGrantStart(d, t, 'full-review', {}, {}, capacity);
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions: ['Postgres or SQLite?'] }),
  );
  return d.task(t.id).wait?.detail['question_id'] as string;
}

const holders = (d: StoreDriver) => d.store.readSlots().map((s) => s.holder_task_id);
const borrowers = (d: StoreDriver) => d.store.readLoans().map((l) => l.borrower_task_id);

describe('loans skip a task sharing files with a slot holder', () => {
  it('lends the reservation to the next task whose declared scope is apart', async () => {
    const { d, scheduler } = setup();
    const a = task(1, { scope: ['src/engine/**'] });
    startedAndAsking(d, a);
    const b = task(2, { priority: 5, scope: ['src/engine/runtime.ts'] });
    const c = task(3, { scope: ['docs/**'] });
    await confirmed(d, b);
    await confirmed(d, c);

    const r = await scheduler.tick();
    expect(r.lent).toEqual([c.id]);
    expect(r.passed_over).toEqual([b.id]);
    expect(borrowers(d)).toEqual([c.id]);
    expect(d.task(b.id).execution).toMatchObject({ holding: null, request: { group: 'fresh' } });
  });

  it('does not lend to a task sharing files with another running holder', async () => {
    const { d, scheduler } = setup({ concurrency: 2 });
    const a = task(1, { scope: ['src/a.ts'] });
    startedAndAsking(d, a, 2);
    const h = task(2, { priority: 9, scope: ['src/h.ts'] });
    await confirmed(d, h);
    expect((await scheduler.tick()).granted).toEqual([h.id]);
    const b = task(3, { priority: 5, scope: ['src/h.ts'] });
    const c = task(4, { scope: ['src/c.ts'] });
    await confirmed(d, b);
    await confirmed(d, c);

    const r = await scheduler.tick();
    expect(r.lent).toEqual([c.id]);
    expect(r.passed_over).toEqual([b.id]);
  });

  it('keeps today’s behavior for a task with no branch and nothing declared', async () => {
    const { d, scheduler } = setup();
    const a = task(1, { scope: ['src/engine/**'] });
    startedAndAsking(d, a);
    const b = task(2);
    await confirmed(d, b);
    const r = await scheduler.tick();
    expect(r.lent).toEqual([b.id]);
    expect(r.passed_over).toEqual([]);
  });
});

describe('slots skip a task sharing files with a holder (concurrency > 1)', () => {
  it('grants two overlapping tasks one at a time and a separate one alongside', async () => {
    const { d, scheduler } = setup({ concurrency: 2 });
    const a = task(1, { priority: 9, scope: ['src/engine'] });
    const b = task(2, { priority: 5, scope: ['src/engine/*.ts'] });
    const c = task(3, { scope: ['docs/**'] });
    for (const t of [a, b, c]) await confirmed(d, t);

    const r = await scheduler.tick();
    expect(r.granted).toEqual([a.id, c.id]);
    expect(r.passed_over).toEqual([b.id]);
    expect(holders(d)).toEqual([a.id, c.id]);
  });

  it('a started task granted its slot again in the pass blocks a fresh one sharing its files', async () => {
    const { d, scheduler } = setup({ concurrency: 2, reservationMs: 60_000 });
    const a = task(1, { scope: ['src/shared.ts'] });
    const qid = startedAndAsking(d, a, 2);
    d.now += 60_000;
    expect((await scheduler.tick()).expired).toEqual([a.id]);
    d.must(a.id, { kind: 'answer', question_id: qid as Uuid, answer: 'SQLite' });
    expect(d.task(a.id).execution.request?.group).toBe('resumed');
    const b = task(2, { scope: ['src/shared.ts'] });
    await confirmed(d, b);

    const r = await scheduler.tick();
    expect(r.granted).toEqual([a.id]);
    expect(r.passed_over).toEqual([b.id]);
    expect(holders(d)).toEqual([a.id]);
  });

  it('blocks on files the holder’s branch changed, not only on what it declared', async () => {
    const h = task(1, { priority: 9 });
    const b = task(2, { priority: 5, scope: ['src/x.ts'] });
    const { d, scheduler } = setup({
      concurrency: 2,
      // The holder declared nothing; its branch changed src/x.ts.
      scopes: (taskIds) =>
        Promise.resolve(
          new Map(
            taskIds.map((id) => [
              id,
              {
                project: 'acme',
                files: id === h.id ? ['src/x.ts'] : (d.task(id).task.scope ?? null),
              },
            ]),
          ),
        ),
    });
    await confirmed(d, h);
    expect((await scheduler.tick()).granted).toEqual([h.id]);
    await confirmed(d, b);

    const r = await scheduler.tick();
    expect(r.granted).toEqual([]);
    expect(r.passed_over).toEqual([b.id]);
  });
});

describe('the store and engine honour a passed-over request (FR-044.08)', () => {
  it('grants and lends past it and rejects a grant naming it', async () => {
    const { d } = setup();
    const a = task(1);
    startedAndAsking(d, a);
    const b = task(2, { priority: 5 });
    const c = task(3);
    await confirmed(d, b);
    await confirmed(d, c);
    // Queue them without granting: the scheduler would lend at once.
    for (const t of [b, c]) d.must(t.id, { kind: 'request_execution' });
    const rb = d.task(b.id).execution.request?.request_id as string;

    const g = d.store.lendNext(d.now as EpochMs, [], { passedOver: new Set([rb]) });
    expect(g.ok && g.value.kind === 'decided' && g.value.task_id).toBe(c.id);

    const bad = d.send(b.id, {
      kind: 'grant_execution',
      request_id: rb as Uuid,
      passed_over: [rb as Uuid],
    });
    expect(bad.ok && bad.value.decision).toMatchObject({
      kind: 'rejected',
      detail: { reason: 'passed_over' },
    });
  });
});

describe('restart keeps declared scopes and the same blocks (FR-044.06/08)', () => {
  it('a reopened store replays the declared scope and still passes the task over', async () => {
    const first = setup();
    const a = task(1, { scope: ['src/engine/**'] });
    startedAndAsking(first.d, a);
    const b = task(2, { scope: ['src/engine/runtime.ts'] });
    await confirmed(first.d, b);
    expect((await first.scheduler.tick()).passed_over).toEqual([b.id]);
    first.d.store.close();

    const d = new StoreDriver(openFileStoreForTest(first.path));
    expect(d.store.verifyProjections().ok).toBe(true);
    expect(d.task(b.id).task.scope).toEqual(['src/engine/runtime.ts']);
    const r = await schedulerFor(d).tick();
    expect(r.lent).toEqual([]);
    expect(r.passed_over).toEqual([b.id]);
    expect(borrowers(d)).toEqual([]);
  });
});
