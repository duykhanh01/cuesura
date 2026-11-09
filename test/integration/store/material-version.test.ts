import { describe, expect, it } from 'vitest';
import type { TaskState } from '../../../src/domain/state.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { materialDigest } from '../../../src/engine/material.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { authz, buildTask, envelope } from '../../support/builders.ts';
import { A, ci, observation } from '../../support/observation.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { expectAccepted, publishData, started, toCode, USAGE } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { reviewToCi, toPublish } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// Issue #262: background events while CI runs must not make a person's version stale; a material
// change still does.

const tempDir = useTempDir('cusr-material-');
const OWNER = { authz: authz(['operate'], 'owner') };
const PENDING = { build: 'success', test: 'pending' } as const;

function waitingOnCi(): { d: StoreDriver; t: CanonicalTask } {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const t = buildTask();
  createGrantStart(d, t, 'full-review', {}, {});
  toPublish(d, t, A, {});
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: A,
  });
  reviewToCi(d, t.id);
  d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', ci(A, PENDING));
  expect(d.task(t.id).wait).toMatchObject({ reason: 'ci', detail: { code: 'checks_incomplete' } });
  return { d, t };
}

/** One CI poll round: the timer fires, the read runs and answers with `checks`. */
function poll(
  d: StoreDriver,
  t: CanonicalTask,
  checks: Record<string, 'success' | 'failure' | 'pending'> = PENDING,
) {
  d.now += 60_000;
  d.fire();
  d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', ci(A, checks));
}

const stale = { ok: false, error: { code: 'conflict', reason: 'stale_version' } };

describe('expected_version across background events (#262)', () => {
  it('a poll that reads the same CI records no new CI evidence', () => {
    const { d, t } = waitingOnCi();
    const from = d.task(t.id).version;
    poll(d, t);
    const types = d.store.readEvents(t.id, from + 1).map((e) => e.type);
    expect(types).toEqual([
      'TimerFired',
      'TaskResumed',
      'EffectRequested',
      'EffectStarted',
      'EffectCompleted',
      'TimerArmed',
      'TaskWaiting',
    ]);
    expect(d.task(t.id).evidence.ci).toHaveLength(1);
  });

  it.each([
    ['pause', { kind: 'pause', reason: 'look later' }],
    ['cancel', { kind: 'cancel', reason: 'not needed' }],
  ] as const)('%s with a version read before 10 minutes of unchanged CI is accepted', (_, trig) => {
    const { d, t } = waitingOnCi();
    d.must(t.id, observation(d, t, 'open', A, { ci: ci(A, PENDING) }));
    const read = d.task(t.id).version;
    for (let i = 0; i < 10; i++) poll(d, t);
    // Later observation rounds in the same window move the version too.
    d.must(t.id, observation(d, t, 'open', A, { ci: ci(A, PENDING) }));
    expect(d.task(t.id).version).toBeGreaterThan(read);
    const r = d.send(t.id, trig, { ...OWNER, expected_version: read });
    expect(r).toMatchObject({ ok: true, value: { decision: { kind: 'accepted' } } });
  });

  it('a CI result that changes the wait still makes the earlier version stale', () => {
    const { d, t } = waitingOnCi();
    const read = d.task(t.id).version;
    poll(d, t, { build: 'success', test: 'success' });
    expect(d.task(t.id).wait).toMatchObject({ reason: 'approval', detail: { code: 'merge' } });
    expect(
      d.send(t.id, { kind: 'pause', reason: 'x' }, { ...OWNER, expected_version: read }),
    ).toMatchObject(stale);
  });

  it('a command that changed the task makes the version it was sent with stale for the next one', () => {
    const { d, t } = waitingOnCi();
    const read = d.task(t.id).version;
    d.must(t.id, { kind: 'pause', reason: 'look later' }, { ...OWNER, expected_version: read });
    expect(
      d.send(t.id, { kind: 'cancel', reason: 'x' }, { ...OWNER, expected_version: read }),
    ).toMatchObject(stale);
  });

  it('a message sent meanwhile makes the earlier version stale', () => {
    const { d, t } = waitingOnCi();
    const read = d.task(t.id).version;
    d.must(
      t.id,
      { kind: 'message', body: 'note', behavior: 'queue' },
      { ...OWNER, expected_version: read },
    );
    expect(
      d.send(t.id, { kind: 'pause', reason: 'x' }, { ...OWNER, expected_version: read }),
    ).toMatchObject(stale);
  });

  it('a version ahead of the task, or a daemon trigger with an older version, stays stale', () => {
    const { d, t } = waitingOnCi();
    const read = d.task(t.id).version;
    expect(
      d.send(t.id, { kind: 'pause', reason: 'x' }, { ...OWNER, expected_version: read + 1 }),
    ).toMatchObject(stale);
    poll(d, t);
    const env = envelope(t.id, { kind: 'observation_due' }, { now: d.now, expected_version: read });
    expect(d.deliver(env)).toMatchObject(stale);
  });
});

describe('decisions on the same state contend for the same version (#262 review)', () => {
  const T0 = '0'.repeat(40);
  const T1 = '1'.repeat(40);
  const T2 = '2'.repeat(40);
  const PREPARE = {
    base_sha: 'base0000',
    worktree_ref: 'wt',
    branch: 'b',
    setup: { ran: false, passed: true },
  };
  const moved = (d: StoreDriver, t: CanonicalTask, known: string, observed: string) =>
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'unknown',
      invoked: false,
      worktree: { known, observed },
    });

  it('a worktree change seen again after someone took the first one does not let the old version take it', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      ...PREPARE,
      worktree_tree: T0,
    });
    moved(d, t, T0, T1);
    const read = d.task(t.id).version;
    d.must(t.id, { kind: 'recheck', target: 'worktree' });
    moved(d, t, T1, T2);
    expect(d.task(t.id).wait?.detail).toMatchObject({ code: 'worktree_changed', observed: T2 });
    expect(
      d.send(t.id, { kind: 'recheck', target: 'worktree' }, { expected_version: read }),
    ).toMatchObject(stale);
  });

  it('a continue decided before another continue and its failed attempts is stale', () => {
    const sim = started(buildTask(), {
      policy: {
        roles: { coder: { model: 'sonnet', effort: 'medium', ladder: [{ effort: 'high' }] } },
        limits: { max_escalations: 0 },
      },
    });
    toCode(sim);
    const exhaust = () => {
      for (let i = 0; i < 2; i++)
        sim.complete(sim.pendingOne('start_agent').id, 'failed', {
          failure_class: 'quality',
          invoked: true,
          usage: USAGE,
          signature: 'C1',
        });
      expect(sim.s.wait?.detail.code).toBe('escalations_exhausted');
    };
    exhaust();
    const read = sim.s.version;
    expectAccepted(sim.when({ kind: 'continue' }));
    exhaust();
    const then = replay(sim.events.slice(0, read));
    expect(then?.version).toBe(read);
    expect(materialDigest(then as TaskState)).not.toBe(materialDigest(sim.s));
  });
});

describe('materialDigest (#262)', () => {
  const { d, t } = waitingOnCi();
  const base = d.task(t.id);
  const digestWith = (f: (s: TaskState) => void) => {
    const s = structuredClone(base);
    f(s);
    return materialDigest(s);
  };

  it('ignores what background work moves: timers, effects, operations, CI poll counters, observations, the wait timer', () => {
    expect(
      digestWith((s) => {
        s.version += 40;
        s.timers = {};
        s.effects = {};
        s.ci_polls += 3;
        s.operations = {};
        s.artifacts = {};
        s.run.ci_wait = {};
        if (s.observation !== null) s.observation.budget.count += 5;
        if (s.wait !== null) s.wait.detail['timer_id'] = 'other';
      }),
    ).toBe(materialDigest(base));
  });

  it.each<[string, (s: TaskState) => void]>([
    ['status', (s) => (s.status = 'RUNNING')],
    ['wait reason', (s) => s.wait !== null && (s.wait.reason = 'infra')],
    [
      'open question',
      (s) =>
        (s.questions['q'] = {
          id: 'q',
          step: null,
          attempt_id: null,
          revision: s.revision,
          body: '?',
          status: 'open',
          answer: null,
          answered_by: null,
          resume: { kind: 'none' },
        }),
    ],
    ['run config', (s) => (s.run.frozen_digest = 'sha256:other')],
    ['policy', (s) => s.policy_ref !== null && (s.policy_ref.version += 1)],
    ['wait detail', (s) => s.wait !== null && (s.wait.detail['observed'] = 'other')],
    ['accepted worktree', (s) => (s.run.worktree_tree = 'other')],
    ['budget use', (s) => (s.budget.agent_runs.used += 1)],
    ['CI evidence', (s) => s.evidence.ci.push(...s.evidence.ci)],
  ])('changes with the %s', (_, f) => {
    expect(digestWith(f)).not.toBe(materialDigest(base));
  });
});
