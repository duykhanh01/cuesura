import { describe, expect, it } from 'vitest';
import { startTask } from '../../../src/application/start.ts';
import type { StartResult } from '../../../src/application/start.ts';
import { Scheduler } from '../../../src/daemon/scheduler.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { injectEvents, openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { authz, buildTask, uuidOf } from '../../support/builders.ts';
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

const tempDir = useTempDir('cusr-scheduler-');

function setup(start?: (taskId: string) => Promise<StartResult>, queuePaused?: () => boolean) {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  let ids = 7_000;
  const clock = { now: () => d.now as EpochMs, monotonic: () => d.now };
  const realStart = (taskId: string) =>
    startTask(
      {
        store: d.store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () =>
          Promise.resolve({
            user: userConfig(),
            packs: PACKS,
            manifests: MANIFESTS,
          }),
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
  return {
    d,
    scheduler: new Scheduler({
      store: d.store,
      clock,
      start: start ?? realStart,
      startRetryMs: 60_000,
      newId: () => uuidOf(ids++),
      ...(queuePaused === undefined ? {} : { queuePaused }),
    }),
  };
}

const task = (n: number, over: Partial<CanonicalTask> = {}) =>
  buildTask({ id: uuidOf(n), source_key: `cli:${n}`, ...over });
/** Created with a run selection confirmed by the owner, so the scheduler may queue it. */
async function confirmed(d: StoreDriver, t: CanonicalTask): Promise<void> {
  d.must(t.id, { kind: 'create_task', task: t });
  proposeAndConfirm(d, t, await configuredSelection(t, 'full-review'));
}

const slotHolder = (d: StoreDriver) => d.store.readSlot()?.holder_task_id ?? null;

/** Started under the slot, then asks a question: the attempt is over, so nothing slot-bound is left. */
function startedAndAsking(d: StoreDriver, t: CanonicalTask): string {
  createGrantStart(d, t);
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions: ['Postgres or SQLite?'] }),
  );
  return Object.keys(d.task(t.id).questions)[0] as string;
}

describe('scheduler queues, grants and starts one task at a time (T034, FR-044)', () => {
  it('a READY task without a confirmed run selection is never queued (M01)', async () => {
    const { d, scheduler } = setup();
    const t = task(9);
    d.must(t.id, { kind: 'create_task', task: t });
    d.must(t.id, {
      kind: 'propose_run_config',
      selection: await configuredSelection(t, 'direct-pr'),
    });
    expect(await scheduler.tick()).toMatchObject({ queued: [], granted: null });
    expect(d.task(t.id)).toMatchObject({
      status: 'READY',
      execution: { request: null },
    });
  });

  it('starts the highest priority READY task; the other stays READY with no deadline and is not preempting', async () => {
    const { d, scheduler } = setup();
    const low = task(1, { priority: 0 });
    const high = task(2, { priority: 5 });
    for (const t of [low, high]) await confirmed(d, t);

    const first = await scheduler.tick();
    expect(first.queued).toEqual([low.id, high.id]);
    expect(first).toMatchObject({
      granted: high.id,
      started: {
        task_id: high.id,
        result: { kind: 'submitted', frozen: true },
      },
    });
    expect(d.task(high.id).status).toBe('RUNNING');
    expect(slotHolder(d)).toBe(high.id);

    d.now += 3_600_000;
    const second = await scheduler.tick();
    expect(second).toMatchObject({ queued: [], granted: null, started: null });
    expect(d.task(low.id)).toMatchObject({
      status: 'READY',
      deadline_at: null,
      policy_ref: null,
    });
    expect(d.task(low.id).execution.request).not.toBeNull();
    expect(slotHolder(d)).toBe(high.id);
  });

  it('a start that cannot reach Git/GitHub returns the slot and waits before queueing again', async () => {
    const calls: string[] = [];
    let ids = 7_500;
    const { d, scheduler } = setup((id) => {
      calls.push(id);
      return startTask(
        {
          store: d.store,
          ports: {
            git: fakeGit(),
            github: fakeGitHub('unknown'),
            host: fakeHost(),
          },
          configInputs: () =>
            Promise.resolve({
              user: userConfig(),
              packs: PACKS,
              manifests: MANIFESTS,
            }),
          docs: {
            prompts: () => Promise.resolve([]),
            attachments: () => Promise.resolve([]),
          },
          now: () => d.now,
          newId: () => uuidOf(ids++),
        },
        id,
      );
    });
    const t = task(1);
    await confirmed(d, t);
    expect((await scheduler.tick()).started?.result).toMatchObject({
      kind: 'unavailable',
      check: 'github_repo',
    });
    expect(d.task(t.id)).toMatchObject({
      status: 'READY',
      execution: { request: null, holding: null },
    });

    d.now += 1_000;
    expect(await scheduler.tick()).toMatchObject({ queued: [], started: null });
    d.now += 60_000;
    expect((await scheduler.tick()).queued).toEqual([t.id]);
    expect(calls).toEqual([t.id, t.id]);
  });
});

describe('the engine returns the slot when nothing slot-bound is left and queues resumed work (FR-044.02/03/05)', () => {
  it('a task waiting for a human gives the slot back; its next attempt waits as WAITING/policy execution_slot', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const a = task(1);
    const qid = startedAndAsking(d, a);
    expect(d.task(a.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'human_input' },
      execution: { holding: null },
    });
    expect(d.store.readSlot()).toBeNull();
    const deadline = d.task(a.id).deadline_at;
    expect(deadline).not.toBeNull();

    // Another task takes the slot meanwhile.
    const b = task(2);
    createGrantStart(d, b);
    expect(slotHolder(d)).toBe(b.id);

    d.must(a.id, {
      kind: 'answer',
      question_id: qid as Uuid,
      answer: 'SQLite',
    });
    expect(d.task(a.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code: 'execution_slot' },
        resume: { kind: 'start_attempt', step: 'code' },
      },
      deadline_at: deadline,
    });
    expect(d.task(a.id).execution.request).toMatchObject({ group: 'resumed' });
    expect(d.pending(a.id, 'start_agent')).toEqual([]);

    // Waiting for the slot counts toward the deadline; once it passes the request leaves the queue.
    d.now = deadline as number;
    d.fire();
    expect(d.task(a.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'deadline' } },
      execution: { request: null },
    });
    expect(d.store.readQueue(10).map((q) => q.task_id)).toEqual([]);
  });

  it('a resumed request is granted before a fresh one of the same priority and resumes RUNNING', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const a = task(1);
    const b = task(2);
    const qid = startedAndAsking(d, a);
    createGrantStart(d, b);
    d.must(a.id, {
      kind: 'answer',
      question_id: qid as Uuid,
      answer: 'SQLite',
    });

    // A fresh task with the same priority asks for the slot after a's resumed request.
    const c = task(3);
    d.now += 1_000;
    d.must(c.id, { kind: 'create_task', task: c });
    d.must(c.id, { kind: 'request_execution' });

    // b finishes its slot work by asking a question too, which frees the slot.
    d.complete(b.id, d.pendingOne(b.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(
      b.id,
      d.pendingOne(b.id, 'start_agent').id,
      'succeeded',
      agentData('needs_input', { questions: ['?'] }),
    );
    expect(d.store.readSlot()).toBeNull();

    const g = d.store.grantNext(
      d.now as EpochMs,
      Array.from({ length: 8 }, (_, i) => uuidOf(8_000 + i)),
    );
    expect(g.ok && g.value.kind === 'decided' && g.value.task_id).toBe(a.id);
    expect(d.task(a.id)).toMatchObject({ status: 'RUNNING', wait: null });
    expect(d.pending(a.id, 'start_agent')).toHaveLength(1);
    expect(d.task(c.id)).toMatchObject({ status: 'READY' });
  });

  it('an open request is withdrawn when the task stops qualifying for it', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const b = task(2);
    createGrantStart(d, b);
    const a = task(1);
    d.must(a.id, { kind: 'create_task', task: a });
    d.must(a.id, { kind: 'request_execution' });
    d.must(a.id, { kind: 'cancel', reason: 'no longer needed' });
    expect(d.store.readQueue(10).map((q) => q.task_id)).toEqual([]);
  });
});

describe('dependencies are satisfied only by a recorded terminal status (T034, FR-001.02/03)', () => {
  it('releases the dependent after DONE with provenance, never before', async () => {
    const { d, scheduler } = setup();
    const pre = task(1);
    await confirmed(d, pre);
    const child = task(2, { depends_on: [pre.id] });
    await confirmed(d, child);
    expect(d.task(child.id)).toMatchObject({
      status: 'PENDING',
      wait: { detail: { code: 'dependency_pending' } },
    });

    // While the prerequisite runs (e.g. still draining after a merge), the dependent keeps waiting.
    const first = await scheduler.tick();
    expect(first.dependencies).toEqual([]);
    expect(d.task(pre.id).status).toBe('RUNNING');
    expect(d.task(child.id).status).toBe('PENDING');

    injectEvents(d.store, pre.id, [
      {
        type: 'TaskCompleted',
        revision: 1,
        actor: 'store',
        payload: { reason: 'external_confirmation' },
      },
    ]);
    const second = await scheduler.tick();
    expect(second.dependencies).toMatchObject([
      { task_id: child.id, depends_on: pre.id, status: 'DONE' },
    ]);
    expect(d.task(child.id).status).toBe('READY');
    const env = storeDb(d.store)
      .prepare('SELECT envelope_json FROM accepted_triggers WHERE dedup_key = ?')
      .get(`dep:${child.id}:${pre.id}:DONE`) as {
      envelope_json: string;
    };
    expect(JSON.parse(env.envelope_json)).toMatchObject({
      trigger: { provenance: { unverified_reason: null } },
    });

    // A later pass sends nothing again.
    expect((await scheduler.tick()).dependencies).toEqual([]);
  });

  it('a cancelled prerequisite moves the dependent to dependency_failed', async () => {
    const { d, scheduler } = setup();
    const pre = task(1);
    d.must(pre.id, { kind: 'create_task', task: pre });
    const child = task(2, { depends_on: [pre.id] });
    d.must(child.id, { kind: 'create_task', task: child });
    d.must(pre.id, { kind: 'cancel', reason: 'dropped' });
    await scheduler.tick();
    expect(d.task(child.id)).toMatchObject({
      status: 'PENDING',
      wait: { detail: { code: 'dependency_failed' } },
    });
  });
});

describe('a paused task and the execution slot (issue #142)', () => {
  const owner = { authz: authz(['operate'], 'owner') };

  it('gives the slot back once its running work is done, so the next task starts; resume queues it again', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    const b = task(2);
    createGrantStart(d, a);
    await confirmed(d, b);
    d.must(a.id, { kind: 'pause', reason: 'release upgrade' }, owner);
    // The prepare handed out before the pause still runs and keeps the slot until it ends.
    expect(slotHolder(d)).toBe(a.id);
    d.complete(a.id, d.pendingOne(a.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    expect(d.task(a.id).wait?.detail.code).toBe('paused');
    expect(d.pending(a.id, 'start_agent')).toEqual([]);
    expect(slotHolder(d)).toBeNull();

    await scheduler.tick();
    expect(slotHolder(d)).toBe(b.id);

    d.must(a.id, { kind: 'unpause' }, owner);
    expect(d.task(a.id).wait?.detail.code).toBe('execution_slot');
    expect(d.task(a.id).execution.request).toMatchObject({ group: 'resumed' });
  });

  it('a task not started yet leaves the queue and is not queued again until resumed', async () => {
    const { d, scheduler } = setup();
    const a = task(3);
    await confirmed(d, a);
    // Queued and granted, the start not run yet.
    d.must(a.id, { kind: 'request_execution' });
    d.grantNext();
    expect(slotHolder(d)).toBe(a.id);
    d.must(a.id, { kind: 'pause', reason: 'later' }, owner);
    expect(d.task(a.id).execution).toMatchObject({ request: null, holding: null });
    expect(slotHolder(d)).toBeNull();

    await scheduler.tick();
    expect(d.task(a.id).execution).toMatchObject({ request: null, holding: null });
    expect(d.task(a.id).status).toBe('READY');

    d.must(a.id, { kind: 'unpause' }, owner);
    await scheduler.tick();
    expect(slotHolder(d)).toBe(a.id);
  });
});

describe('cusr queue pause (issue #142)', () => {
  it('queues and grants no task that has not started; a started one still gets the slot back', async () => {
    let paused = true;
    const { d, scheduler } = setup(undefined, () => paused);
    const asking = task(10);
    const fresh = task(11);
    // A higher priority than the started task: first in the queue order, held by the pause all the same.
    const queuedEarlier = task(12, { priority: 5 });
    startedAndAsking(d, asking);
    await confirmed(d, fresh);
    await confirmed(d, queuedEarlier);
    // Queued before the pause: it stays queued, and is granted once the queue is resumed.
    d.must(queuedEarlier.id, { kind: 'request_execution' });

    await scheduler.tick();
    expect(d.task(fresh.id).execution.request).toBeNull();
    expect(slotHolder(d)).toBeNull();

    // The started task gets its answer and asks for the slot again: it is granted past the fresh one.
    const qid = d.task(asking.id).wait?.detail['question_id'] as Uuid;
    d.must(asking.id, { kind: 'answer', question_id: qid, answer: 'SQLite' });
    await scheduler.tick();
    expect(slotHolder(d)).toBe(asking.id);
    expect(d.task(queuedEarlier.id).execution.holding).toBeNull();

    paused = false;
    d.complete(
      asking.id,
      d.pendingOne(asking.id, 'start_agent').id,
      'succeeded',
      agentData('needs_input', { questions: ['Again?'] }),
    );
    await scheduler.tick();
    expect(slotHolder(d)).toBe(queuedEarlier.id);
  });
});

describe('cusr queue pause after a crash between grant and start (issue #142)', () => {
  it('a task granted the slot but never started gives it back, and is queued again after the resume', async () => {
    let paused = false;
    const starts: string[] = [];
    const { d, scheduler } = setup(
      (id) => {
        starts.push(id);
        return Promise.resolve({ kind: 'unavailable', detail: 'not in this test' } as never);
      },
      () => paused,
    );
    const t = task(20);
    await confirmed(d, t);
    d.must(t.id, { kind: 'request_execution' });
    d.grantNext();
    expect(slotHolder(d)).toBe(t.id);

    paused = true;
    await scheduler.tick();
    expect(starts).toEqual([]);
    expect(slotHolder(d)).toBeNull();
    expect(d.task(t.id)).toMatchObject({
      status: 'READY',
      execution: { request: null, holding: null },
    });

    paused = false;
    await scheduler.tick();
    expect(slotHolder(d)).toBe(t.id);
    expect(starts).toEqual([t.id]);
  });
});
