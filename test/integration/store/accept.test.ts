import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import { computeRequestHash } from '../../../src/domain/trigger.ts';
import { openFileStoreForTest, openMemoryStore, storeDb } from '../../../src/store/testing.ts';
import { authz, buildTask, envelope, freezeOk, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const TASK = buildTask();

function counts(d: StoreDriver): Record<string, number> {
  const db = storeDb(d.store);
  const n = (t: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  return {
    events: n('events'),
    effects: n('effects'),
    timers: n('timers'),
    accepted: n('accepted_triggers'),
  };
}

describe('Store.accept (T078)', () => {
  const tmp = useTempDir();

  it('atomically commits events, projections, effects, timers, and snapshots to a real file', () => {
    const store = openFileStoreForTest(dbPath(tmp()));
    const d = new StoreDriver(store);
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    const r = d.must(TASK.id, { kind: 'start', freeze: freezeOk(TASK) });

    const s = d.task(TASK.id);
    expect(s.status).toBe('RUNNING');
    expect(r.task_version).toBe(s.version);
    expect(r.global_seq_range).not.toBeNull();
    expect(store.readPolicy(TASK.id, 1)?.policy_hash).toBe(s.policy_ref?.hash);
    expect(store.readContext(TASK.id, 1)?.context_hash).toBe(s.context_ref?.hash);
    expect(d.pendingOne(TASK.id, 'prepare').status).toBe('pending');
    expect(store.dueTimers(Number.MAX_SAFE_INTEGER as never, 10).map((t) => t.kind)).toContain(
      'deadline',
    );
    expect(store.verifyProjections()).toMatchObject({
      ok: true,
      mismatches: [],
    });
    store.close();
  });

  it('replaying a key returns the original result without writes (FR-026)', () => {
    const d = new StoreDriver(openMemoryStore());
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    const env = d.envelope(TASK.id, { kind: 'start', freeze: freezeOk(TASK) });
    const first = d.deliver(env);
    const before = counts(d);

    // now and ids are deliberately different because neither belongs to request_hash.
    const again = {
      ...env,
      now: (env.now + 60_000) as typeof env.now,
      ids: [uuidOf(999)],
    };
    const second = d.deliver(again);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.duplicate).toBe(true);
    expect(canonicalJson({ ...second.value, duplicate: false })).toBe(canonicalJson(first.value));
    expect(counts(d)).toEqual(before);
  });

  it('request_hash includes task_id, expected_version, and actor', () => {
    const base = {
      task_id: TASK.id,
      trigger: { kind: 'cancel', reason: 'x' },
      expected_version: 3,
      authz: authz(),
    };
    const h = computeRequestHash(base);
    expect(computeRequestHash({ ...base, task_id: uuidOf(2) })).not.toBe(h);
    expect(computeRequestHash({ ...base, expected_version: 4 })).not.toBe(h);
    expect(
      computeRequestHash({
        ...base,
        authz: authz(['operate'], 'someone-else'),
      }),
    ).not.toBe(h);
    expect(computeRequestHash({ ...base, authz: authz(['admin']) })).toBe(h);

    const d = new StoreDriver(openMemoryStore());
    d.must(TASK.id, { kind: 'create_task', task: TASK }, { dedup_key: 'k1' });
    const other = d.send(
      TASK.id,
      { kind: 'create_task', task: TASK },
      { dedup_key: 'k1', authz: authz(['operate'], 'mallory') },
    );
    expect(other).toEqual({
      ok: false,
      error: { code: 'conflict', reason: 'request_hash_mismatch' },
    });
  });

  it('a stale expected_version returns conflict/stale_version without writes (FR-028)', () => {
    const d = new StoreDriver(openMemoryStore());
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    const before = counts(d);
    const v = d.task(TASK.id).version;
    const r = d.send(
      TASK.id,
      { kind: 'cancel', reason: 'stale request' },
      { expected_version: v - 1 },
    );
    expect(r).toEqual({
      ok: false,
      error: { code: 'conflict', reason: 'stale_version' },
    });
    expect(counts(d)).toEqual(before);

    expect(d.task(TASK.id).version).toBe(v);
  });

  it('persists Decision.rejected without events and replays the same rejection', () => {
    const d = new StoreDriver(openMemoryStore());
    const env = d.envelope(TASK.id, { kind: 'confirm_task' });
    const r1 = d.deliver(env);
    expect(r1.ok && r1.value.decision).toEqual({
      kind: 'rejected',
      code: 'unknown_task',
    });
    expect(counts(d)).toEqual({
      events: 0,
      effects: 0,
      timers: 0,
      accepted: 1,
    });
    const r2 = d.deliver(env);
    expect(r2.ok && r2.value).toMatchObject({
      duplicate: true,
      decision: { kind: 'rejected', code: 'unknown_task' },
      global_seq_range: null,
    });
  });

  it('an incorrect request_hash returns invalid_trigger without events', () => {
    const d = new StoreDriver(openMemoryStore());
    const env = {
      ...d.envelope(TASK.id, { kind: 'create_task', task: TASK }),
      request_hash: computeRequestHash({ task_id: TASK.id, trigger: {} }),
    };
    const r = d.deliver(env);
    expect(r.ok && r.value.decision).toMatchObject({
      kind: 'rejected',
      code: 'invalid_trigger',
    });
    expect(d.store.readTask(TASK.id)).toBeNull();
  });

  it('seq/global_seq follow acceptance order rather than envelope IDs or timestamps (FR-027)', () => {
    const A = buildTask({ id: uuidOf(10), source_key: 'cli:a' });
    const B = buildTask({ id: uuidOf(11), source_key: 'cli:b' });
    const store = openMemoryStore();
    // B has an earlier timestamp and a smaller ID but is accepted later.
    const envA = envelope(
      A.id,
      { kind: 'create_task', task: A },
      {
        now: 2_000_000_000_000,
        ids: [uuidOf(900)],
        authz: authz(),
        expected_version: 0,
        dedup_key: 'a',
      },
    );
    const envB = envelope(
      B.id,
      { kind: 'create_task', task: B },
      {
        now: 1_000_000_000_000,
        ids: [uuidOf(1)],
        authz: authz(),
        expected_version: 0,
        dedup_key: 'b',
      },
    );
    const ra = store.accept(envA);
    const rb = store.accept(envB);
    if (!ra.ok || !rb.ok) throw new Error('accept failed');
    const [, aTo] = ra.value.global_seq_range ?? [0, 0];
    const [bFrom] = rb.value.global_seq_range ?? [0, 0];
    expect(bFrom).toBe(aTo + 1);
    const evA = store.readEvents(A.id);
    expect(evA.map((e) => e.seq)).toEqual(evA.map((_, i) => i + 1));
    expect(store.readEvents(B.id)[0]?.seq).toBe(1);
  });

  it('ID exhaustion does not record deduplication and permits retry with enough IDs', () => {
    const d = new StoreDriver(openMemoryStore());
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    const before = counts(d);
    const env = d.envelope(TASK.id, { kind: 'start', freeze: freezeOk(TASK) });

    expect(d.deliver({ ...env, ids: [] })).toMatchObject({
      ok: true,
      value: {
        duplicate: false,
        decision: { kind: 'rejected', code: 'id_pool_exhausted' },
      },
    });
    expect(counts(d)).toEqual(before);
    expect(d.deliver(env)).toMatchObject({
      ok: true,
      value: { duplicate: false, decision: { kind: 'accepted' } },
    });
  });

  it('reused IDs from another task cause id_collision and rollback without changing projections (FR-029)', () => {
    const A = buildTask({ id: uuidOf(11) });
    const B = buildTask({ id: uuidOf(12) });
    const d = new StoreDriver(openMemoryStore());
    d.must(A.id, { kind: 'create_task', task: A });
    d.must(B.id, { kind: 'create_task', task: B });
    const startA = d.envelope(A.id, { kind: 'start', freeze: freezeOk(A) });
    expect(d.deliver(startA)).toMatchObject({
      ok: true,
      value: { decision: { kind: 'accepted' } },
    });
    const before = counts(d);

    const startB = d.envelope(B.id, { kind: 'start', freeze: freezeOk(B) });
    expect(d.deliver({ ...startB, ids: startA.ids })).toEqual({
      ok: false,
      error: { code: 'conflict', reason: 'id_collision' },
    });
    expect(counts(d)).toEqual(before);
    expect(d.task(B.id).status).toBe('READY');
    expect(d.store.verifyProjections().ok).toBe(true);

    expect(d.deliver(startB)).toMatchObject({
      ok: true,
      value: { decision: { kind: 'accepted' } },
    });
    const db = storeDb(d.store);
    for (const t of ['effects', 'timers']) {
      const rows = db.prepare(`SELECT task_id, count(*) AS n FROM ${t} GROUP BY task_id`).all();
      expect(rows, t).toHaveLength(2);
    }
    expect(d.store.verifyProjections().ok).toBe(true);
  });
});
