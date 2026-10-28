import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/adapters/ports.ts';
import { DispatchConfigError, Dispatcher, type EffectHandlers } from '../../../src/daemon/dispatch.ts';
import type { Effect } from '../../../src/domain/effect.ts';
import { asEpochMs, type Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';

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
});
