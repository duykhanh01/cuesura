import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/adapters/ports.ts';
import { DispatchConfigError, Dispatcher, type EffectHandlers } from '../../../src/daemon/dispatch.ts';
import type { Effect } from '../../../src/domain/effect.ts';
import { asEpochMs, type EpochMs, type Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';

const HASH = `sha256:${'a'.repeat(64)}` as const;

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
        return Promise.resolve(d.envelope(t.id, { kind: 'effect_result', effect_id: effect.id as Uuid, outcome: 'succeeded', data: PREPARE_DATA }));
      },
    };
    const disp = new Dispatcher({ store: d.store, clock, handlers });
    const report = disp.tick();
    expect(report.started).toEqual([prepare.id]);
    await disp.settle();
    expect(seen).toEqual(['started']);
    expect(d.task(t.id).effects[prepare.id]?.status).toBe('succeeded');
    // The next effect has no handler in this build and stays pending.
    expect(disp.tick().skipped).toContainEqual({ effect_id: d.pendingOne(t.id, 'start_agent').id, reason: 'no_handler' });
  });

  it('never dispatches a legacy task without a runtime snapshot', () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(2) });
    d.must(t.id, { kind: 'create_task', task: t });
    d.must(t.id, { kind: 'start', freeze: freezeOk(t, { limits: { max_wall_ms: 3_600_000 } }) });
    const prepare = d.pendingOne(t.id, 'prepare');
    let called = 0;
    const disp = new Dispatcher({ store: d.store, clock, handlers: { prepare: () => (called++, Promise.reject(new Error('must not run'))) } });
    expect(disp.tick().skipped).toEqual([{ effect_id: prepare.id, reason: 'claim_blocked:legacy_task' }]);
    expect(called).toBe(0);
    expect(d.pendingOne(t.id, 'prepare').status).toBe('pending');
  });

  it('refuses merge: no handler can be registered and a pending merge is never claimed', () => {
    const { clock } = setup();
    const merge = { id: 'm1', task_id: uuidOf(3), revision: 1, kind: 'merge', idem_key: 'k', status: 'pending', request: {}, reservation_id: null } as Effect;
    let claims = 0;
    const store = { pendingEffects: () => [merge], claimEffect: () => (claims++, { ok: false, error: { code: 'not_found' } }) } as unknown as Store;
    expect(() => new Dispatcher({ store, clock, handlers: { merge: () => Promise.reject(new Error('x')) } as EffectHandlers })).toThrow(DispatchConfigError);
    expect(new Dispatcher({ store, clock, handlers: {} }).tick().skipped).toEqual([{ effect_id: 'm1', reason: 'merge_refused' }]);
    expect(claims).toBe(0);
  });

  it('claims nothing while blocked, and a failing handler leaves the effect started for recovery', async () => {
    const { d, clock } = setup();
    const t = buildTask({ id: uuidOf(4) });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const logs: string[] = [];
    const disp = new Dispatcher({ store: d.store, clock, handlers: { prepare: () => Promise.reject(new Error('port down')) }, log: (r) => logs.push(r.event) });
    disp.block('projection mismatch');
    expect(disp.tick()).toEqual({ started: [], skipped: [{ effect_id: prepare.id, reason: 'dispatch_blocked' }] });
    const open = new Dispatcher({ store: d.store, clock, handlers: { prepare: () => Promise.reject(new Error('port down')) }, log: (r) => logs.push(r.event) });
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
          during = { ops: Object.keys(d.task(t.id).operations), release: d.send(t.id, { kind: 'release_execution', request_id: requestId as Uuid, reason: 'idle' }) };
          return Promise.resolve([
            d.envelope(t.id, { kind: 'operation_result', operation_id: operation.operation_id as Uuid, status: 'finished', outcome: 'succeeded', invocation_id: null, processes: [], started_at: d.now as EpochMs, finished_at: d.now as EpochMs, receipt_digest: HASH }),
            d.envelope(t.id, { kind: 'effect_result', effect_id: effect.id as Uuid, outcome: 'succeeded', data: PREPARE_DATA }),
          ]);
        },
      },
    });
    expect(disp.tick().started).toEqual([prepare.id]);
    await disp.settle();
    expect(during).toMatchObject({ ops: [uuidOf(950)], release: { ok: true, value: { decision: { kind: 'rejected', detail: { reason: 'unresolved_operations' } } } } });
    expect(d.task(t.id).operations[uuidOf(950)]).toMatchObject({ effect_id: prepare.id, kind: 'setup', holds_slot: true, status: 'finished', unit: `cusr-op-${uuidOf(950)}.service` });
    expect(d.task(t.id).effects[prepare.id]?.status).toBe('succeeded');
  });

  it('pages past effects that are always skipped, so they never starve later ones', () => {
    const { d, clock } = setup();
    for (let i = 0; i < 3; i++) {
      const legacy = buildTask({ id: uuidOf(10 + i), source_key: `cli:legacy-${i}` });
      d.must(legacy.id, { kind: 'create_task', task: legacy });
      d.must(legacy.id, { kind: 'start', freeze: freezeOk(legacy, { limits: { max_wall_ms: 3_600_000 } }) });
    }
    const t = buildTask({ id: uuidOf(20), source_key: 'cli:runtime' });
    createGrantStart(d, t);
    const prepare = d.pendingOne(t.id, 'prepare');
    const disp = new Dispatcher({ store: d.store, clock, batch: 2, handlers: { prepare: () => new Promise(() => undefined) } });
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
            finish = () => r(d.envelope(t.id, { kind: 'effect_result', effect_id: effect.id as Uuid, outcome: 'succeeded', data: PREPARE_DATA }));
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
