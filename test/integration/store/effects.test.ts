import { describe, expect, it } from 'vitest';
import type { Uuid } from '../../../src/shared/brand.ts';
import {
  injectEvents,
  openMemoryStore,
  storeDb,
} from '../../../src/store/testing.ts';
import { buildTask, freezeOk } from '../../support/builders.ts';
import {
  agentData,
  gatesData,
  PREPARE_DATA,
  reviewData,
} from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';

const TASK = buildTask();

function started(seed = 1, limits?: { max_wall_ms?: number }): StoreDriver {
  const d = new StoreDriver(openMemoryStore(), seed);
  d.must(TASK.id, { kind: 'create_task', task: TASK });
  d.must(TASK.id, {
    kind: 'start',
    freeze: freezeOk(TASK, limits !== undefined ? { limits } : {}),
  });
  return d;
}

/** Tới khi publish của revision 1 đang pending (US2 scenario 13). */
function toPublish(seed = 1): StoreDriver {
  const d = started(seed);
  d.complete(
    TASK.id,
    d.pendingOne(TASK.id, 'prepare').id,
    'succeeded',
    PREPARE_DATA,
  );
  d.complete(
    TASK.id,
    d.pendingOne(TASK.id, 'start_agent').id,
    'succeeded',
    agentData('done'),
  );
  d.complete(
    TASK.id,
    d.pendingOne(TASK.id, 'run_gates').id,
    'succeeded',
    gatesData({ build: true, unit: true }),
  );
  d.complete(
    TASK.id,
    d.pendingOne(TASK.id, 'start_agent').id,
    'succeeded',
    reviewData('approve', 'head1'),
  );
  return d;
}

function status(d: StoreDriver, id: string): string | undefined {
  return (
    storeDb(d.store)
      .prepare('SELECT status FROM effects WHERE id = ?')
      .get(id) as { status: string } | undefined
  )?.status;
}

describe('Effect trong kho (T080)', () => {
  it('UNIQUE(idem_key): effect thứ hai cùng khoá bị SQLite từ chối', () => {
    const d = started();
    const e = d.pendingOne(TASK.id, 'prepare');
    expect(() =>
      injectEvents(d.store, TASK.id, [
        {
          type: 'EffectRequested',
          revision: 1,
          actor: 'test',
          payload: {
            effect_id: '00000000-0000-7000-8000-00000000dead',
            kind: 'prepare',
            idem_key: e.idem_key,
            logical_id: 'dup',
            step: 'prepare',
            attempt_id: null,
            reservation_id: null,
            target_effect_id: null,
            request: {},
          },
        },
      ]),
    ).toThrow(/UNIQUE constraint failed: effects.idem_key/);
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('claim pending → started, append EffectStarted có causation.claim; claim lần hai → not_pending', () => {
    const d = started();
    const e = d.pendingOne(TASK.id, 'prepare');
    const r = d.claim(e.id);
    expect(r).toMatchObject({
      ok: true,
      value: { id: e.id, status: 'started' },
    });
    const last = d.store.readEvents(TASK.id).at(-1);
    expect(last).toMatchObject({
      type: 'EffectStarted',
      causation: { dedup_key: null, claim: e.id },
      payload: { effect_id: e.id, at: d.now },
    });
    expect(d.claim(e.id)).toEqual({
      ok: false,
      error: { code: 'not_pending' },
    });
    expect(d.claim('00000000-0000-7000-8000-0000000000ff')).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('effect bị vô hiệu hoá → effect_invalidated', () => {
    const d = toPublish();
    const pub = d.pendingOne(TASK.id, 'publish');
    d.must(TASK.id, {
      kind: 'source_updated',
      task: { ...TASK, title: 'Mới' },
    });
    d.must(TASK.id, {
      kind: 'drift_choice',
      choice: 'apply_new',
      freeze: freezeOk({ ...TASK, title: 'Mới', revision: 2 }),
    });
    expect(status(d, pub.id)).toBe('invalidated');
    expect(d.claim(pub.id)).toEqual({
      ok: false,
      error: { code: 'effect_invalidated' },
    });
  });

  it('source_drift: chặn, effect giữ pending; continue_old → claim được (US2 scenario 13 ở mức kho)', () => {
    const d = toPublish();
    const pub = d.pendingOne(TASK.id, 'publish');
    d.must(TASK.id, {
      kind: 'source_updated',
      task: { ...TASK, title: 'Mới' },
    });
    const v = d.task(TASK.id).version;
    expect(d.claim(pub.id)).toEqual({
      ok: false,
      error: { code: 'claim_blocked', reason: 'source_drift' },
    });
    expect(status(d, pub.id)).toBe('pending');
    expect(d.task(TASK.id).version).toBe(v);
    d.must(TASK.id, { kind: 'drift_choice', choice: 'continue_old' });
    expect(d.claim(pub.id).ok).toBe(true);
  });

  it('deadline: effect tạo trước hạn không claim được sau deadline_at (FR-023)', () => {
    const d = started(1, { max_wall_ms: 3_600_000 });
    const e = d.pendingOne(TASK.id, 'prepare');
    d.now += 3_600_000;
    expect(d.claim(e.id)).toEqual({
      ok: false,
      error: { code: 'claim_blocked', reason: 'deadline' },
    });
    expect(status(d, e.id)).toBe('pending');
  });

  it('stale_revision, cancelling, terminal, task_waiting: kho trả đúng lý do của claimable', () => {
    const cases: [string, (d: StoreDriver, effectId: string) => void][] = [
      [
        'stale_revision',
        (d) =>
          injectEvents(d.store, TASK.id, [
            {
              type: 'RevisionApplied',
              revision: 2,
              actor: 'test',
              payload: { revision: 2, task: { ...TASK, revision: 2 } },
            },
          ]),
      ],
      [
        'cancelling',
        (d) =>
          injectEvents(d.store, TASK.id, [
            {
              type: 'CancelRequested',
              revision: 1,
              actor: 'test',
              payload: { by: 'owner', reason: 'x', at: d.now },
            },
          ]),
      ],
      [
        'terminal',
        (d) =>
          injectEvents(d.store, TASK.id, [
            {
              type: 'TaskCancelled',
              revision: 1,
              actor: 'test',
              payload: { reason: 'x' },
            },
          ]),
      ],
      [
        'task_waiting',
        (d) =>
          injectEvents(d.store, TASK.id, [
            {
              type: 'TaskWaiting',
              revision: 1,
              actor: 'test',
              payload: {
                wait: {
                  reason: 'human_input',
                  detail: { code: 'agent_question' },
                  resume_when: ['answer(q)'],
                  exit_paths: ['cancel'],
                  resume: { kind: 'none' },
                },
              },
            },
          ]),
      ],
    ];
    for (const [reason, setup] of cases) {
      const d = started();
      const e = d.pendingOne(TASK.id, 'prepare');
      setup(d, e.id);
      expect(d.claim(e.id), reason).toEqual({
        ok: false,
        error: { code: 'claim_blocked', reason },
      });
      expect(status(d, e.id), reason).toBe('pending');
      expect(d.store.verifyProjections().ok, reason).toBe(true);
    }
  });

  it('stop_attempt và reconcile không bị chặn khi đang hủy', () => {
    const d = started();
    d.complete(
      TASK.id,
      d.pendingOne(TASK.id, 'prepare').id,
      'succeeded',
      PREPARE_DATA,
    );
    const agent = d.pendingOne(TASK.id, 'start_agent');
    expect(d.claim(agent.id).ok).toBe(true);
    // Một effect unknown để có effect reconcile.
    d.must(TASK.id, {
      kind: 'effect_result',
      effect_id: agent.id as Uuid,
      outcome: 'unknown',
    });
    const probe = d.pendingOne(TASK.id, 'reconcile');
    d.must(TASK.id, { kind: 'cancel', reason: 'dừng' });
    expect(d.task(TASK.id).cancellation).not.toBeNull();
    expect(d.claim(probe.id)).toMatchObject({
      ok: true,
      value: { kind: 'reconcile', status: 'started' },
    });
    for (const stop of d.pending(TASK.id, 'stop_attempt'))
      expect(d.claim(stop.id).ok).toBe(true);
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('pendingEffects theo thứ tự được yêu cầu', () => {
    const d = toPublish();
    const all = d.store.pendingEffects(100);
    expect(all.map((e) => e.kind)).toEqual(['publish']);
  });
});
