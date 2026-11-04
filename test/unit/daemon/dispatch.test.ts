import { describe, expect, it } from 'vitest';
import { resultEnvelopes } from '../../../src/daemon/ingest.ts';
import { DaemonStopping, type Clock } from '../../../src/adapters/ports.ts';
import {
  DispatchConfigError,
  Dispatcher,
  storageFailure,
  type EffectHandlers,
} from '../../../src/daemon/dispatch.ts';
import type { Effect } from '../../../src/domain/effect.ts';
import { asEpochMs, type EpochMs, type Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';

const HASH = `sha256:${'a'.repeat(64)}` as const;

/** The store with one write method answering `write_failed`; `calls` counts the refused writes. */
function refusing(store: Store, method: 'accept' | 'claimEffect', calls: { n: number }): Store {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === method)
        return () => (
          calls.n++,
          { ok: false, error: { code: 'write_failed', cause: 'disk_full' } }
        );
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function setup(): { d: StoreDriver; clock: Clock } {
  const d = new StoreDriver(openMemoryStore());
  return { d, clock: { now: () => asEpochMs(d.now), monotonic: () => d.now } };
}

describe('Dispatcher (T026)', () => {
  it('claims a committed effect before running its handler and accepts the returned facts', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(1) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const seen: string[] = [];
    const handlers: EffectHandlers = {
      prepare: (effect) => {
        // The claim is committed before the handler runs.
        seen.push(d.store.readTask(t.id)?.effects[effect.id]?.status ?? 'missing');
        return Promise.resolve(
          d.envelope(t.id, {
            kind: 'effect_result',
            effect_id: effect.id as Uuid,
            outcome: 'succeeded',
            data: PREPARE_DATA,
          }),
        );
      },
    };
    const disp = new Dispatcher({ store: d.store, clock, handlers });
    const report = disp.tick();
    expect(report.started).toEqual([prepare.id]);
    await disp.settle();
    expect(seen).toEqual(['started']);
    expect(d.task(t.id).effects[prepare.id]?.status).toBe('succeeded');
    // The next effect has no handler in this build and stays pending.
    expect(disp.tick().skipped).toContainEqual({
      effect_id: d.pendingOne(t.id, 'start_agent').id,
      reason: 'no_handler',
    });
  });

  it('never dispatches a legacy task without a runtime snapshot', () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(2) });
    d.must(t.id, { kind: 'create_task', task: t });
    d.must(t.id, {
      kind: 'start',
      freeze: freezeOk(t, { limits: { max_wall_ms: 3_600_000 } }),
    });
    const prepare = d.pendingOne(t.id, 'prepare');
    let called = 0;
    const disp = new Dispatcher({
      store: d.store,
      clock,
      handlers: {
        prepare: () => (called++, Promise.reject(new Error('must not run'))),
      },
    });
    expect(disp.tick().skipped).toEqual([
      { effect_id: prepare.id, reason: 'claim_blocked:legacy_task' },
    ]);
    expect(called).toBe(0);
    expect(d.pendingOne(t.id, 'prepare').status).toBe('pending');
  });

  it('refuses merge: no handler can be registered and a pending merge is never claimed', () => {
    const { clock } = setup();
    const merge = {
      id: 'm1',
      task_id: uuidOf(3),
      revision: 1,
      kind: 'merge',
      idem_key: 'k',
      status: 'pending',
      request: {},
      reservation_id: null,
    } as Effect;
    let claims = 0;
    const store = {
      pendingEffects: () => [merge],
      claimEffect: () => (claims++, { ok: false, error: { code: 'not_found' } }),
    } as unknown as Store;
    expect(
      () =>
        new Dispatcher({
          store,
          clock,
          handlers: {
            merge: () => Promise.reject(new Error('x')),
          } as EffectHandlers,
        }),
    ).toThrow(DispatchConfigError);
    expect(new Dispatcher({ store, clock, handlers: {} }).tick().skipped).toEqual([
      { effect_id: 'm1', reason: 'merge_refused' },
    ]);
    expect(claims).toBe(0);
  });

  it('while held for an unresolved claim, holds business effects and still runs service effects', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(5) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const ran: string[] = [];
    const disp = new Dispatcher({
      store: d.store,
      clock,
      handlers: {
        prepare: () => Promise.reject(new Error('must not run while held')),
        reconcile: (effect) => (
          ran.push(effect.kind),
          Promise.resolve(
            d.envelope(t.id, {
              kind: 'effect_reconciled',
              effect_id: effect.request['effect_id'] as Uuid,
              finding: 'still_unknown',
            }),
          )
        ),
      },
    });
    disp.hold('unresolved claims (1)');
    expect(disp.tick()).toEqual({
      started: [],
      skipped: [{ effect_id: prepare.id, reason: 'dispatch_held' }],
    });
    d.complete(t.id, prepare.id, 'unknown');
    const reconcile = d.pendingOne(t.id, 'reconcile');
    expect(disp.tick().started).toEqual([reconcile.id]);
    await disp.settle();
    expect(ran).toEqual(['reconcile']);
    disp.hold(null);
    expect(disp.heldReason).toBeNull();
  });

  it('claims nothing while blocked, and a failing handler leaves the effect started for recovery', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(4) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const logs: string[] = [];
    const disp = new Dispatcher({
      store: d.store,
      clock,
      handlers: { prepare: () => Promise.reject(new Error('port down')) },
      log: (r) => logs.push(r.event),
    });
    disp.block('projection mismatch');
    expect(disp.tick()).toEqual({
      started: [],
      skipped: [{ effect_id: prepare.id, reason: 'dispatch_blocked' }],
    });
    const open = new Dispatcher({
      store: d.store,
      clock,
      handlers: { prepare: () => Promise.reject(new Error('port down')) },
      log: (r) => logs.push(r.event),
    });
    expect(open.tick().started).toEqual([prepare.id]);
    await open.settle();
    expect(logs).toEqual(['handler_failed']);
    expect(d.task(t.id).effects[prepare.id]?.status).toBe('started');
  });

  it('commits the operation with the claim, so the slot stays held while the handler runs', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(5) });
    const requestId = createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    let during: unknown = null;
    const disp = new Dispatcher({
      store: d.store,
      clock,
      newId: () => uuidOf(950),
      handlers: {
        prepare: (effect, _signal, operation) => {
          during = {
            ops: Object.keys(d.task(t.id).operations),
            release: d.send(t.id, {
              kind: 'release_execution',
              request_id: requestId as Uuid,
              reason: 'idle',
            }),
          };
          return Promise.resolve([
            d.envelope(t.id, {
              kind: 'operation_result',
              operation_id: operation.operation_id as Uuid,
              status: 'finished',
              outcome: 'succeeded',
              invocation_id: null,
              processes: [],
              started_at: d.now as EpochMs,
              finished_at: d.now as EpochMs,
              receipt_digest: HASH,
            }),
            d.envelope(t.id, {
              kind: 'effect_result',
              effect_id: effect.id as Uuid,
              outcome: 'succeeded',
              data: PREPARE_DATA,
            }),
          ]);
        },
      },
    });
    expect(disp.tick().started).toEqual([prepare.id]);
    await disp.settle();
    expect(during).toMatchObject({
      ops: [uuidOf(950)],
      release: {
        ok: true,
        value: {
          decision: {
            kind: 'rejected',
            detail: { reason: 'unresolved_operations' },
          },
        },
      },
    });
    expect(d.task(t.id).operations[uuidOf(950)]).toMatchObject({
      effect_id: prepare.id,
      kind: 'setup',
      holds_slot: true,
      status: 'finished',
      unit: `cusr-op-${uuidOf(950)}.service`,
    });
    expect(d.task(t.id).effects[prepare.id]?.status).toBe('succeeded');
  });

  it('pages past effects that are always skipped, so they never starve later ones', () => {
    const { d, clock } = setup();
    for (let i = 0; i < 3; i++) {
      const legacy = buildTask({
        id: uuidOf(10 + i),
        source_key: `cli:legacy-${i}`,
      });
      d.must(legacy.id, { kind: 'create_task', task: legacy });
      d.must(legacy.id, {
        kind: 'start',
        freeze: freezeOk(legacy, { limits: { max_wall_ms: 3_600_000 } }),
      });
    }
    const t = buildTask({ id: uuidOf(20), source_key: 'cli:runtime' });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const disp = new Dispatcher({
      store: d.store,
      clock,
      batch: 2,
      handlers: { prepare: () => new Promise(() => undefined) },
    });
    const report = disp.tick();
    expect(report.started).toEqual([prepare.id]);
    expect(report.skipped.filter((s) => s.reason === 'claim_blocked:legacy_task')).toHaveLength(3);
  });

  it('forgets an in-flight handler that throws synchronously', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(6) });
    createGrantStart(d, t);
    const disp = new Dispatcher({
      store: d.store,
      clock,
      handlers: {
        prepare: () => {
          throw new Error('sync');
        },
      },
    });
    expect(disp.tick().started).toHaveLength(1);
    await disp.settle();
    expect(disp.inFlight).toBe(0);
  });

  it('tells a daemon stop from a stop of the work in the signal a handler sees', async () => {
    const running = () => {
      const { d, clock } = setup();
      const t = buildTask({ id: uuidOf(8) });
      createGrantStart(d, t);
      const prepare = d.pendingOne(t.id, 'prepare');
      let reason: unknown;
      const disp = new Dispatcher({
        store: d.store,
        clock,
        handlers: {
          prepare: (_effect, signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                reason = signal.reason;
                reject(new Error('stopped'));
              });
            }),
        },
      });
      disp.tick();
      return { disp, id: prepare.id, reason: () => reason };
    };
    const handlerStarted = () => new Promise((r) => setImmediate(r));

    const byStop = running();
    await handlerStarted();
    await byStop.disp.stop(1_000);
    expect(byStop.reason()).toBeInstanceOf(DaemonStopping);

    const byAbort = running();
    await handlerStarted();
    expect(byAbort.disp.abort(byAbort.id)).toBe(true);
    await byAbort.disp.settle();
    expect(byAbort.reason()).toBeDefined();
    expect(byAbort.reason()).not.toBeInstanceOf(DaemonStopping);
  });

  it('stop() gives up on a handler that ignores abort after the grace period and drops its late result', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(7) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    let finish: () => void = () => undefined;
    const logs: string[] = [];
    const disp = new Dispatcher({
      store: d.store,
      clock,
      log: (r) => logs.push(r.event),
      handlers: {
        prepare: (effect) =>
          new Promise((r) => {
            finish = () =>
              r(
                d.envelope(t.id, {
                  kind: 'effect_result',
                  effect_id: effect.id as Uuid,
                  outcome: 'succeeded',
                  data: PREPARE_DATA,
                }),
              );
          }),
      },
    });
    disp.tick();
    expect(await disp.stop(20)).toEqual([prepare.id]);
    finish();
    await disp.settle();
    expect(logs).toEqual(['handler_abandoned', 'result_dropped']);
    expect(d.task(t.id).effects[prepare.id]?.status).toBe('started');
  });
});

let ids = 77_000;

describe('process marks (FR-034.01)', () => {
  const marking = (log: string[], fail = false) => ({
    write: (id: string) => {
      if (fail) throw errno('ENOSPC');
      log.push(`write:${id}`);
    },
    clear: (id: string) => log.push(`clear:${id}`),
  });

  it('marks an operation before its handler runs and clears it once the facts are written', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(21) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const log: string[] = [];
    const disp = new Dispatcher({
      store: d.store,
      clock,
      marks: marking(log),
      handlers: {
        prepare: (effect, _s, op) => {
          log.push(`handler:${op.operation_id}`);
          return Promise.resolve(
            resultEnvelopes(
              effect,
              op,
              null,
              { outcome: 'succeeded', data: PREPARE_DATA },
              { now: d.now, started_at: d.now, newId: () => uuidOf(ids++) },
            ),
          );
        },
      },
    });
    disp.tick();
    await disp.settle();
    const op = Object.values(d.task(t.id).operations).find((o) => o.effect_id === prepare.id);
    expect(log).toEqual([`write:${op?.id}`, `handler:${op?.id}`, `clear:${op?.id}`]);
  });

  it('keeps the mark of an operation left unknown: its processes may still run (FR-034.01)', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(24) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const log: string[] = [];
    const disp = new Dispatcher({
      store: d.store,
      clock,
      marks: marking(log),
      handlers: {
        prepare: (effect, _s, op) =>
          Promise.resolve(
            resultEnvelopes(
              effect,
              op,
              null,
              { outcome: 'unknown', detail: 'stop not seen through' },
              { now: d.now, started_at: d.now, newId: () => uuidOf(ids++) },
            ),
          ),
      },
    });
    disp.tick();
    await disp.settle();
    const op = Object.values(d.task(t.id).operations).find((o) => o.effect_id === prepare.id);
    expect(op?.status).toBe('unknown');
    expect(log).toEqual([`write:${op?.id}`]);
  });

  it('keeps the mark when the handler fails, and runs no handler whose mark cannot be written', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(22) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const log: string[] = [];
    const failing = new Dispatcher({
      store: d.store,
      clock,
      marks: marking(log),
      handlers: { prepare: () => Promise.reject(new Error('port down')) },
    });
    failing.tick();
    await failing.settle();
    expect(log.filter((l) => l.startsWith('clear:'))).toEqual([]);

    const other = setup();
    createGrantStart(other.d, buildTask({ id: uuidOf(23) }));
    let ran = 0;
    const unmarked = new Dispatcher({
      store: other.d.store,
      clock: other.clock,
      marks: marking([], true),
      handlers: { prepare: () => (ran++, Promise.reject(new Error('no'))) },
    });
    unmarked.tick();
    await unmarked.settle();
    expect(ran).toBe(0);
    expect(unmarked.latchedReason).toContain('ENOSPC');
    expect(d.task(t.id).effects[prepare.id]?.status).toBe('started');
  });
});

describe('store failure latch (T092, FR-023)', () => {
  it('a refused claim latches: nothing else is claimed, service effects included, and block/hold do not lift it', () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(8) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const calls = { n: 0 };
    const logs: string[] = [];
    const disp = new Dispatcher({
      store: refusing(d.store, 'claimEffect', calls),
      clock,
      handlers: { prepare: () => Promise.reject(new Error('must not run')) },
      log: (r) => logs.push(`${r.event}:${r.detail ?? ''}`),
    });
    expect(disp.tick()).toEqual({
      started: [],
      skipped: [{ effect_id: prepare.id, reason: 'write_failed' }],
    });
    expect(disp.latchedReason).toBe('store write failed: disk_full');
    expect(logs).toEqual(['store_latched:store write failed: disk_full']);

    disp.block('stopping');
    disp.hold(null);
    expect(disp.tick().skipped).toEqual([{ effect_id: prepare.id, reason: 'store_unwritable' }]);
    expect(calls.n).toBe(1);
    expect(d.pendingOne(t.id, 'prepare').status).toBe('pending');
  });

  it('a result the store refuses latches; the effect stays started and no later fact of it is written', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(9) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const calls = { n: 0 };
    const result = (effectId: string): ReturnType<StoreDriver['envelope']> =>
      d.envelope(t.id, {
        kind: 'effect_result',
        effect_id: effectId as Uuid,
        outcome: 'succeeded',
        data: PREPARE_DATA,
      });
    const disp = new Dispatcher({
      store: refusing(d.store, 'accept', calls),
      clock,
      handlers: {
        prepare: (effect) => Promise.resolve([result(effect.id), result(effect.id)]),
      },
    });
    expect(disp.tick().started).toEqual([prepare.id]);
    await disp.settle();
    expect(calls.n).toBe(1);
    expect(disp.latchedReason).toBe('store write failed: disk_full');
    expect(d.task(t.id).effects[prepare.id]?.status).toBe('started');
    expect(disp.tick()).toEqual({ started: [], skipped: [] });
  });

  it('a handler failing on a full or read-only filesystem latches; any other failure does not', async () => {
    for (const [error, latched] of [
      [errno('ENOSPC'), 'filesystem write failed: ENOSPC'],
      [errno('EROFS'), 'filesystem write failed: EROFS'],
      [errno('SQLITE_IOERR_WRITE'), 'store write failed: io_error'],
      [errno('ENOENT'), null],
      [new Error('port down'), null],
    ] as const) {
      const { d, clock } = setup();
      const t = buildTask({ id: uuidOf(10) });
      createGrantStart(d, t);
      const disp = new Dispatcher({
        store: d.store,
        clock,
        handlers: { prepare: () => Promise.reject(error) },
      });
      expect(disp.tick().started).toHaveLength(1);
      await disp.settle();
      expect(disp.latchedReason).toBe(latched);
      expect(storageFailure(error)).toBe(latched);
    }
  });
});
