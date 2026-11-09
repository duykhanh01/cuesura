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
});
