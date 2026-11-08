import { describe, expect, it } from 'vitest';
import type { ProcessPort } from '../../../src/adapters/ports.ts';
import { notifyDependents } from '../../../src/application/dependency.ts';
import {
  DRAIN_KILL_VERIFY_MS,
  DRAIN_TERM_GRACE_MS,
  drainingTasks,
  drainRound,
} from '../../../src/daemon/drain.ts';
import type { MergeProof } from '../../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { ciData, publishData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { toPublish, reviewToCi } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-drain-');
const HEAD = 'a'.repeat(40);

const proof: MergeProof = {
  subject: {
    provider: 'github',
    immutable_repo_id: 'R1',
    subject_id: '700',
    target_ref: 'main',
    head_ref: 'cusr/t',
  },
  merged_at: 1,
  merged_head_sha: HEAD,
  checked_head_sha: null,
  merge_commit_sha: 'c'.repeat(40),
  observation_id: 'obs-1',
  evidence_ref: 'ev-1',
};

const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));

/** Through publish and PR; `await_ci` is left pending. */
function toCi(d: StoreDriver, t: CanonicalTask): void {
  createGrantStart(d, t);
  toPublish(d, t, HEAD);
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: HEAD,
  });
  reviewToCi(d, t.id);
}

function merged(d: StoreDriver, t: CanonicalTask): void {
  d.must(t.id, {
    kind: 'observation_result',
    observation: {
      observation_id: 'obs-1',
      source: 'timer',
      requested_at: d.now,
      observed_at: d.now,
      generation: 1,
      subject: proof.subject,
      status: 'merged',
      observed_head: HEAD,
      raw_evidence_ref: 'ev-1',
      completeness: { merge_proof: true, quality: false },
    },
    remote_digest: `sha256:${'d'.repeat(64)}`,
  });
  d.must(t.id, { kind: 'external_completion', proof, unverified_reason: null });
}

const types = (d: StoreDriver, t: CanonicalTask) => d.store.readEvents(t.id).map((e) => e.type);
const count = (d: StoreDriver, t: CanonicalTask, type: string) =>
  types(d, t).filter((x) => x === type).length;

describe('drain after a merge proof (T046, FR-040.04–09)', () => {
  it('with nothing in flight the task is DONE at once, exactly once, and releases its dependents', () => {
    const d = setup();
    const t = buildTask();
    const child = buildTask({
      id: uuidOf(2),
      source_key: 'cli:2',
      depends_on: [t.id],
    });
    toCi(d, t);
    d.must(child.id, { kind: 'create_task', task: child });
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ciData(HEAD, { build: 'success', test: 'success' }),
    );
    merged(d, t);
    expect(d.task(t.id)).toMatchObject({
      status: 'DONE',
      completion: { finalized_at: d.now },
    });
    expect(count(d, t, 'TaskCompleted')).toBe(1);
    // The slot was reserved while the PR waited for the merge; it goes back as the task ends.
    expect(types(d, t).slice(-4)).toEqual([
      'DrainStarted',
      'DrainFinished',
      'ExecutionReleased',
      'TaskCompleted',
    ]);
    expect(d.store.readSlots()).toEqual([]);

    notifyDependents(d.store, d.now);
    expect(d.task(child.id).status).toBe('READY');
  });

  it('work in flight keeps the task in merge_cleanup_pending; a late result is recorded, not acted on', () => {
    const d = setup();
    const t = buildTask();
    const child = buildTask({
      id: uuidOf(2),
      source_key: 'cli:2',
      depends_on: [t.id],
    });
    toCi(d, t);
    d.must(child.id, { kind: 'create_task', task: child });
    const ci = d.pendingOne(t.id, 'await_ci');
    expect(d.claim(ci.id).ok).toBe(true);
    merged(d, t);
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { detail: { code: 'merge_cleanup_pending' } },
    });
    expect(d.task(t.id).blockers.map((b) => b.code)).toContain('merge_cleanup_pending');
    notifyDependents(d.store, d.now);
    expect(d.task(child.id).status).toBe('PENDING');

    // CI comes back red after the merge: recorded, no fix starts, and the drain finishes.
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: ci.id as Uuid,
      outcome: 'succeeded',
      data: ciData(HEAD, { build: 'failure', test: 'success' }),
    });
    expect(d.pending(t.id)).toEqual([]);
    expect(d.task(t.id).status).toBe('DONE');
    expect(count(d, t, 'TaskCompleted')).toBe(1);
    notifyDependents(d.store, d.now);
    expect(d.task(child.id).status).toBe('READY');
  });

  it('pauses after three rounds or past five minutes, and ignores rounds while paused', () => {
    const d = setup();
    const t = buildTask();
    toCi(d, t);
    d.claim(d.pendingOne(t.id, 'await_ci').id);
    merged(d, t);
    for (let i = 0; i < 3; i++) d.must(t.id, { kind: 'drain_result', pending_operations: [] });
    expect(d.task(t.id).completion?.drain).toMatchObject({
      count: 3,
      paused: true,
      auto_exhausted: true,
    });
    d.must(t.id, { kind: 'drain_result', pending_operations: [] });
    expect(d.task(t.id).completion?.drain.count).toBe(3);
    expect(d.task(t.id).status).toBe('WAITING');

    const late = setup();
    const u = buildTask();
    toCi(late, u);
    late.claim(late.pendingOne(u.id, 'await_ci').id);
    merged(late, u);
    late.now += 5 * 60_000;
    late.must(u.id, { kind: 'drain_result', pending_operations: [] });
    expect(late.task(u.id).completion?.drain).toMatchObject({
      paused: true,
      auto_exhausted: false,
    });
  });

  it('a cancel after the merge does not cancel: the task ends DONE with the cancel recorded late', () => {
    const d = setup();
    const t = buildTask();
    toCi(d, t);
    const ci = d.pendingOne(t.id, 'await_ci');
    d.claim(ci.id);
    merged(d, t);
    d.must(t.id, { kind: 'cancel', reason: 'too late' });
    expect(d.task(t.id).status).toBe('WAITING');
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: ci.id as Uuid,
      outcome: 'succeeded',
      data: ciData(HEAD, { build: 'success', test: 'success' }),
    });
    expect(d.task(t.id).status).toBe('DONE');
    expect(types(d, t)).toContain('CancelRecordedLate');
    expect(types(d, t)).not.toContain('TaskCancelled');
  });

  it('the daemon round stops a running operation with TERM/KILL caps and reports it still pending', async () => {
    const d = setup();
    const t = buildTask();
    toCi(d, t);
    const ci = d.pendingOne(t.id, 'await_ci');
    const claimed = d.store.claimEffect(ci.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: uuidOf(950),
        kind: 'github',
        launch_nonce: 'n',
        unit: 'cusr-op-950.service',
        holds_slot: false,
      },
    });
    expect(claimed.ok).toBe(true);
    merged(d, t);
    expect(drainingTasks(d.store)).toEqual([t.id]);

    const stops: unknown[] = [];
    const process: ProcessPort = {
      launch: () => Promise.reject(new Error('no launches in a drain')),
      inspect: (id) =>
        Promise.resolve({
          unit: `cusr-op-${id}.service`,
          state: 'active',
          invocation_id: 'inv',
          cgroup: '/x',
        }),
      stop: (id, opts) => {
        stops.push({ id, ...opts });
        return Promise.resolve('stopped');
      },
    };
    const r = await drainRound(
      {
        store: d.store,
        process,
        clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      },
      t.id,
    );
    expect(stops).toEqual([
      {
        id: uuidOf(950),
        term_grace_ms: DRAIN_TERM_GRACE_MS,
        kill_verify_ms: DRAIN_KILL_VERIFY_MS,
      },
    ]);
    expect(r).toMatchObject({
      pending_operations: [uuidOf(950)],
      outcome: { decision: { kind: 'accepted' } },
    });
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      completion: { drain: { count: 1 } },
    });
  });
});
