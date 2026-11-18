import { describe, expect, it } from 'vitest';
import { provenance } from '../../../src/application/queries.ts';
import type { TaskState } from '../../../src/domain/state.ts';

describe('task_show provenance', () => {
  it('lists attempts in the order they began, not by their count within a step', () => {
    // UUIDv7-like IDs: the prefix is the time. `n` restarts for each step.
    const attempts = [
      ['0001', 'review', 1],
      ['0002', 'fix_review', 1],
      ['0003', 'fix_review', 2],
      ['0004', 'review', 2],
      ['0005', 'fix_review', 3],
    ] as const;
    const state = {
      pr_ref: null,
      head_sha: null,
      base_sha: null,
      observation: null,
      current_step: null,
      // Keys in another order than the attempts began, as a stored state's sorted keys may be.
      attempts: Object.fromEntries(
        [...attempts]
          .reverse()
          .map(([id, step, n]) => [
            `k${n}${step}`,
            { id, step, n, binding: 'b', reservation_id: 'r', usage: null },
          ]),
      ),
      budget: { reservations: {}, agent_runs: 0, escalations: 0 },
      artifacts: {},
    } as unknown as TaskState;
    const usage = (provenance(state) as { usage: { attempt_id: string }[] }).usage;
    expect(usage.map((u) => u.attempt_id)).toEqual(['0001', '0002', '0003', '0004', '0005']);
  });

  it('identifies the active attempt from the current step, even before it reports usage', () => {
    const active = { id: '0002', status: 'running', stop_requested: false, usage: null };
    const state = {
      status: 'RUNNING',
      current_step: 'code',
      current_attempt: { code: active.id, review: '0003' },
      attempts: { [active.id]: active, '0003': { ...active, id: '0003' } },
      budget: { reservations: {} },
      artifacts: {},
    } as unknown as TaskState;
    expect(provenance(state).active_attempt_id).toBe(active.id);
    expect(provenance({ ...state, current_step: 'gates' }).active_attempt_id).toBeNull();
    expect(provenance({ ...state, status: 'CANCELLED' }).active_attempt_id).toBeNull();
    active.stop_requested = true;
    expect(provenance(state).active_attempt_id).toBeNull();
  });
});
