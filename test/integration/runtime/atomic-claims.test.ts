import { describe, expect, it } from 'vitest';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest, injectEvents, storeDb } from '../../../src/store/testing.ts';
import type { CrashPoint } from '../../../src/store/testing.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-runtime-');
const HASH = `sha256:${'a'.repeat(64)}` as const;

function driver(crash?: (p: CrashPoint) => void): StoreDriver {
  return new StoreDriver(
    openFileStoreForTest(dbPath(tempDir()), crash === undefined ? {} : { crash }),
  );
}

function count(d: StoreDriver, sql: string): number {
  return (storeDb(d.store).prepare(sql).get() as { n: number }).n;
}

const opClaim = (n: number, holds_slot = true) => ({
  require_runtime: true,
  operation: {
    operation_id: uuidOf(900 + n),
    kind: 'setup' as const,
    launch_nonce: `nonce-${n}`,
    unit: `cusr-op-${n}.service`,
    holds_slot,
  },
});

describe('execution slot grants (FR-044.01, T025)', () => {
  it('with concurrency 1 grants one slot, in priority then request order, and keeps the rest queued', () => {
    const d = driver();
    const low = buildTask({
      id: uuidOf(1),
      source_key: 'cli:low',
      priority: 0,
    });
    const high = buildTask({
      id: uuidOf(2),
      source_key: 'cli:high',
      priority: 5,
    });
    for (const t of [low, high]) {
      d.must(t.id, { kind: 'create_task', task: t });
      d.must(t.id, { kind: 'request_execution' });
      d.now += 1_000;
    }
    expect(d.store.readQueue(10).map((q) => q.task_id)).toEqual([high.id, low.id]);

    const g = d.store.grantNext(d.now as EpochMs);
    expect(g.ok && g.value.kind === 'decided' && g.value.task_id).toBe(high.id);
    expect(d.store.readSlots()[0]?.holder_task_id).toBe(high.id);
    expect(d.task(high.id).execution).toMatchObject({
      request: null,
      holding: { granted_at: d.now },
      accumulated_wait_ms: 1_000,
    });

    const again = d.store.grantNext(d.now as EpochMs);
    expect(again.ok && again.value).toEqual({ kind: 'busy', holders: 1 });
    expect(d.store.readQueue(10).map((q) => q.task_id)).toEqual([low.id]);
    expect(d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('rejects a grant over the cap, and the slot table refuses a second slot for one task', () => {
    const d = driver();
    const a = buildTask({ id: uuidOf(1), source_key: 'cli:a' });
    const b = buildTask({ id: uuidOf(2), source_key: 'cli:b' });
    createGrantStart(d, a);
    d.must(b.id, { kind: 'create_task', task: b });
    d.must(b.id, { kind: 'request_execution' });
    const request_id = d.task(b.id).execution.request?.request_id as Uuid;

    const direct = d.send(b.id, { kind: 'grant_execution', request_id });
    expect(direct.ok && direct.value.decision).toMatchObject({
      kind: 'rejected',
      detail: { reason: 'slot_held', holder_task_ids: [a.id], capacity: 1 },
    });

    // Under a cap of 2 the same request is granted; a replayed grant of it cannot stack a second slot.
    const wider = d.store.grantNext(d.now as EpochMs, [], { capacity: 2 });
    expect(wider.ok && wider.value.kind === 'decided' && wider.value.task_id).toBe(b.id);
    const before = count(d, 'SELECT COUNT(*) AS n FROM events');
    expect(() =>
      injectEvents(d.store, b.id, [
        {
          type: 'ExecutionGranted',
          revision: 1,
          actor: 'test',
          payload: { request_id, at: d.now, waited_ms: 0 },
        },
      ]),
    ).toThrow(/already holds an execution slot/);
    expect(count(d, 'SELECT COUNT(*) AS n FROM events')).toBe(before);
    expect(d.store.readSlots().map((s) => s.holder_task_id)).toEqual([a.id, b.id]);
    expect(d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('a crash inside the grant transaction leaves neither the event nor the slot row', () => {
    let armed = false;
    const d = driver((p) => {
      if (armed && p === 'after_runtime')
        throw Object.assign(new Error('crash'), { code: 'SQLITE_IOERR' });
    });
    const t = buildTask({ id: uuidOf(1) });
    d.must(t.id, { kind: 'create_task', task: t });
    d.must(t.id, { kind: 'request_execution' });
    const events = count(d, 'SELECT COUNT(*) AS n FROM events');
    armed = true;
    const g = d.store.grantNext(d.now as EpochMs);
    expect(g).toMatchObject({
      ok: false,
      error: { code: 'write_failed', cause: 'io_error' },
    });
    expect(count(d, 'SELECT COUNT(*) AS n FROM events')).toBe(events);
    expect(d.store.readSlots()).toEqual([]);
    expect(d.store.readQueue(10)).toHaveLength(1);
    armed = false;
    const retry = d.store.grantNext(d.now as EpochMs);
    expect(retry.ok && retry.value.kind).toBe('decided');
    expect(d.store.verifyProjections()).toMatchObject({ ok: true });
  });
});

describe('operation claims and slot release (T025, FR-044.06)', () => {
  it('commits the operation identity with EffectStarted and keeps the slot until the receipt resolves it', () => {
    const d = driver();
    const t = buildTask({ id: uuidOf(1) });
    const request_id = createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');

    const c = d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, opClaim(1));
    expect(c.ok).toBe(true);
    expect(d.task(t.id).operations[uuidOf(901)]).toMatchObject({
      effect_id: prepare.id,
      status: 'registered',
      holds_slot: true,
    });
    expect(count(d, `SELECT COUNT(*) AS n FROM operations WHERE status = 'registered'`)).toBe(1);

    const blocked = d.send(t.id, {
      kind: 'release_execution',
      request_id: request_id as Uuid,
      reason: 'idle',
    });
    expect(blocked.ok && blocked.value.decision).toMatchObject({
      kind: 'rejected',
      detail: { reason: 'unresolved_operations' },
    });
    expect(d.store.readSlots()[0]?.request_id).toBe(request_id);

    d.must(t.id, {
      kind: 'operation_result',
      operation_id: uuidOf(901),
      status: 'finished',
      outcome: 'succeeded',
      invocation_id: 'inv-1',
      processes: [{ boot_id: 'boot', pid: 42, pgid: 42, start_ticks: 7 }],
      started_at: d.now as EpochMs,
      finished_at: d.now as EpochMs,
      receipt_digest: HASH,
    });
    d.must(t.id, {
      kind: 'release_execution',
      request_id: request_id as Uuid,
      reason: 'idle',
    });
    expect(d.store.readSlots()).toEqual([]);
    expect(d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('refuses a second open operation for the same effect and a reused operation ID', () => {
    const d = driver();
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    expect(d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, opClaim(1)).ok).toBe(true);
    // Claim path itself: the effect is no longer pending.
    expect(d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, opClaim(2))).toMatchObject({
      ok: false,
      error: { code: 'not_pending' },
    });
    // Projection guard: a duplicate open operation on one effect violates the partial unique index.
    expect(() =>
      injectEvents(d.store, t.id, [
        {
          type: 'OperationRegistered',
          revision: 1,
          actor: 'test',
          payload: {
            operation_id: uuidOf(902),
            effect_id: prepare.id,
            attempt_id: null,
            kind: 'setup',
            launch_nonce: 'nonce-2',
            unit: 'u',
            holds_slot: true,
            at: d.now,
          },
        },
      ]),
    ).toThrow(/UNIQUE/);
    expect(() =>
      injectEvents(d.store, t.id, [
        {
          type: 'OperationRegistered',
          revision: 1,
          actor: 'test',
          payload: {
            operation_id: uuidOf(901),
            effect_id: prepare.id,
            attempt_id: null,
            kind: 'setup',
            launch_nonce: 'nonce-3',
            unit: 'u',
            holds_slot: true,
            at: d.now,
          },
        },
      ]),
    ).toThrow(/operations/);
    expect(d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('a slot-bound claim without the slot is rejected and the effect stays pending', () => {
    const d = driver();
    const t = buildTask({ id: uuidOf(1) });
    // Started under the slot, then the slot was released before the prepare effect was claimed.
    const requestId = createGrantStart(d, t);
    d.must(t.id, {
      kind: 'release_execution',
      request_id: requestId as Uuid,
      reason: 'test',
    });
    const prepare = d.pendingOne(t.id, 'prepare');
    expect(d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, opClaim(1))).toMatchObject({
      ok: false,
      error: { code: 'operation_rejected', reason: 'slot_not_held' },
    });
    expect(d.pendingOne(t.id, 'prepare').status).toBe('pending');
    expect(count(d, 'SELECT COUNT(*) AS n FROM operations')).toBe(0);
  });

  it('a legacy task without runtime snapshot is never dispatched by a 002 claim', () => {
    const d = driver();
    const t = buildTask({ id: uuidOf(1) });
    d.must(t.id, { kind: 'create_task', task: t });
    d.must(t.id, {
      kind: 'start',
      freeze: freezeOk(t, { limits: { max_wall_ms: 3_600_000 } }),
    });
    expect(d.task(t.id).runtime_ref).toBeNull();
    const prepare = d.pendingOne(t.id, 'prepare');
    expect(
      d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, {
        require_runtime: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'claim_blocked', reason: 'legacy_task' },
    });
    // The 001 claim path is unchanged.
    expect(d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs).ok).toBe(true);
  });

  it('releases the slot and withdraws the request when the task ends', () => {
    const d = driver();
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(d, t);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    expect(d.task(t.id).status).toBe('CANCELLED');
    expect(d.store.readSlots()).toEqual([]);
    expect(d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('a receipt that arrives after the task ended resolves its operation and frees the slot it kept', () => {
    const d = driver();
    const t = buildTask({ id: uuidOf(1) });
    const request_id = createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    expect(d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, opClaim(1)).ok).toBe(true);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: prepare.id as Uuid,
      outcome: 'succeeded',
      data: PREPARE_DATA,
    });
    expect(d.task(t.id).status).toBe('CANCELLED');
    // The operation is still unresolved, so ending the task did not release the slot.
    expect(d.store.readSlots()[0]).toMatchObject({ request_id });
    d.must(t.id, {
      kind: 'operation_result',
      operation_id: uuidOf(901),
      status: 'finished',
      outcome: 'succeeded',
      invocation_id: 'inv-1',
      processes: [],
      started_at: d.now as EpochMs,
      finished_at: d.now as EpochMs,
      receipt_digest: HASH,
    });
    expect(d.task(t.id)).toMatchObject({
      status: 'CANCELLED',
      operations: { [uuidOf(901)]: { status: 'finished' } },
    });
    expect(d.store.readSlots()).toEqual([]);
    expect(d.store.verifyProjections()).toMatchObject({ ok: true });
  });
});

describe('ingest cursor (FR-036)', () => {
  it('advances the cursor once per range and ignores a replayed range', () => {
    const d = driver();
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    expect(d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, opClaim(1)).ok).toBe(true);
    const artifact = {
      artifact_id: uuidOf(950),
      operation_id: uuidOf(901),
      kind: 'events' as const,
      relative_path: `operations/${uuidOf(901)}/events.jsonl`,
      digest: HASH,
      bytes: 10,
      redaction_version: 1,
      finalized: false,
      acked: false,
    };
    const ingest = {
      kind: 'ingest_record' as const,
      operation_id: uuidOf(901),
      cursor: {
        generation: 0,
        segment: 0,
        byte_offset: 120,
        last_record_seq: 3,
      },
      records: 3,
      digest: HASH,
      artifacts: [artifact],
    };
    d.must(t.id, ingest);
    const events = count(d, 'SELECT COUNT(*) AS n FROM events');
    const replay = d.must(t.id, ingest);
    expect(replay.decision).toMatchObject({
      kind: 'accepted',
      events: [{ type: 'SignalIgnored', payload: { reason: 'stale_cursor' } }],
    });
    expect(count(d, `SELECT COUNT(*) AS n FROM events WHERE type = 'OutputIngested'`)).toBe(1);
    expect(count(d, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(1);
    expect(count(d, 'SELECT COUNT(*) AS n FROM events')).toBe(events + 1);
    expect(
      storeDb(d.store).prepare('SELECT byte_offset, last_record_seq FROM ingest_cursors').get(),
    ).toEqual({ byte_offset: 120, last_record_seq: 3 });
    expect(d.store.verifyProjections()).toMatchObject({ ok: true });
  });
});
