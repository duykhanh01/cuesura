import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { EpochMs } from '../../../src/shared/brand.ts';
import {
  openFileStoreForTest,
  openMemoryStore,
  storeDb,
  type CrashPoint,
} from '../../../src/store/testing.ts';
import { buildTask, freezeOk } from '../../support/builders.ts';
import { ciData, publishData } from '../../support/scenario.ts';
import { StoreDriver, timerIds } from '../../support/store-driver.ts';
import { toPublish, reviewToCi } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';
import { runChild } from '../../support/child.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TASK = buildTask();
const WALL = 3_600_000;

function started(d: StoreDriver): void {
  d.must(TASK.id, { kind: 'create_task', task: TASK });
  d.must(TASK.id, {
    kind: 'start',
    freeze: freezeOk(TASK, { limits: { max_wall_ms: WALL } }),
  });
}

function timerSignals(d: StoreDriver): number {
  return (
    storeDb(d.store)
      .prepare(`SELECT count(*) AS n FROM accepted_triggers WHERE dedup_key LIKE 'timer:%'`)
      .get() as { n: number }
  ).n;
}

describe('Store timers (T081)', () => {
  const tmp = useTempDir();

  it('fireDueTimers emits exactly one logical trigger across repeated calls', () => {
    const d = new StoreDriver(openMemoryStore());
    started(d);
    expect(d.fire()).toEqual([]);
    d.now += WALL;
    const [deadline] = d.store.dueTimers(d.now as EpochMs, 10);
    expect(deadline?.kind).toBe('deadline');

    const fired = d.fire();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      dedup_key: `timer:${deadline?.id}`,
      duplicate: false,
      decision: { kind: 'accepted' },
    });
    expect(d.task(TASK.id).timers[deadline?.id ?? '']?.status).toBe('fired');
    expect(d.task(TASK.id).wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'deadline' },
    });

    expect(d.fire()).toEqual([]);
    expect(timerSignals(d)).toBe(1);

    const env = d.envelope(
      TASK.id,
      { kind: 'timer', timer_id: deadline?.id as never },
      { dedup_key: `timer:${deadline?.id}` },
    );
    expect(d.deliver({ ...env, ids: timerIds(deadline?.id ?? '') })).toMatchObject({
      ok: true,
      value: { duplicate: true },
    });
    expect(timerSignals(d)).toBe(1);
  });

  it('a backward clock does not fire timers early or fail', () => {
    const d = new StoreDriver(openMemoryStore());
    started(d);
    d.now += WALL - 1;
    expect(d.fire()).toEqual([]);
    d.now -= 10 * WALL;
    expect(d.fire()).toEqual([]);
    expect(d.store.dueTimers(d.now as EpochMs, 10)).toEqual([]);
    d.now += 11 * WALL;
    expect(d.fire()).toHaveLength(1);
  });

  it('restarting after an after_commit crash does not fire the timer twice', () => {
    const path = dbPath(tmp());
    const d = new StoreDriver(openFileStoreForTest(path));
    started(d);
    d.store.close();

    const ops = join(tmp(), 'ops.json');
    writeFileSync(ops, JSON.stringify([{ op: 'fire', now: d.now + WALL }]));
    const r = runChild(['apply', path, ops], { CUSR_CRASH_AT: 'after_commit' });
    expect(r.signal, JSON.stringify(r)).toBe('SIGKILL');

    const again = openFileStoreForTest(path);
    const d2 = new StoreDriver(again);
    d2.now = d.now + WALL;
    expect(timerSignals(d2)).toBe(1);
    expect(d2.fire()).toEqual([]);
    expect(timerSignals(d2)).toBe(1);
    expect(again.verifyProjections().ok).toBe(true);
    again.close();
  });

  it('ci_poll ID exhaustion permits retry without recording deduplication (FR-030)', () => {
    const d = new StoreDriver(openMemoryStore());
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    d.must(TASK.id, {
      kind: 'start',
      freeze: freezeOk(TASK, {
        limits: { max_wall_ms: 100 * WALL },
        required_checks: ['A', 'B'],
      }),
    });
    toPublish(d, TASK, 'H');
    d.complete(TASK.id, d.pendingOne(TASK.id, 'publish').id, 'succeeded', publishData('H'));
    d.complete(TASK.id, d.pendingOne(TASK.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#1',
      head_sha: 'H',
    });
    reviewToCi(d, TASK.id);
    d.complete(
      TASK.id,
      d.pendingOne(TASK.id, 'await_ci').id,
      'succeeded',
      ciData('H', { A: 'success' }, { names: ['A'] }),
    );
    const poll = Object.values(d.task(TASK.id).timers).find((t) => t.kind === 'ci_poll');
    if (poll === undefined) throw new Error('ci_poll timer is missing');
    d.now = poll.due_at;

    const r = d.store.fireDueTimers(d.now as EpochMs, 10, () => []);
    expect(r).toMatchObject({
      ok: true,
      value: [{ decision: { kind: 'rejected', code: 'id_pool_exhausted' } }],
    });
    expect(timerSignals(d)).toBe(0);
    expect(d.store.dueTimers(d.now as EpochMs, 10).map((t) => t.id)).toEqual([poll.id]);

    expect(d.fire()).toMatchObject([{ decision: { kind: 'accepted' } }]);
    expect(timerSignals(d)).toBe(1);
    expect(d.task(TASK.id).timers[poll.id]?.status).toBe('fired');
    expect(d.pending(TASK.id, 'await_ci')).toHaveLength(1);
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('timer write failure returns write_failed and leaves the timer due (FR-033)', () => {
    let armed = false;
    const store = openFileStoreForTest(dbPath(tmp()), {
      crash: (p: CrashPoint) => {
        if (armed && p === 'before_commit')
          throw new Database.SqliteError('database is locked', 'SQLITE_BUSY');
      },
    });
    const d = new StoreDriver(store);
    started(d);
    d.now += WALL;
    armed = true;
    expect(d.store.fireDueTimers(d.now as EpochMs, 10, timerIds)).toEqual({
      ok: false,
      error: { code: 'write_failed', cause: 'busy', fired: [] },
    });
    expect(timerSignals(d)).toBe(0);
    expect(d.store.dueTimers(d.now as EpochMs, 10)).toHaveLength(1);

    armed = false;
    expect(d.fire()).toHaveLength(1);
    expect(store.verifyProjections().ok).toBe(true);
    store.close();
  });
});
