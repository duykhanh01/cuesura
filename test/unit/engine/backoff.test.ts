import { describe, expect, it } from 'vitest';
import { backoffDelay, planBackoff } from '../../../src/engine/backoff.ts';

const CFG = { base_ms: 5_000, factor: 2, max_ms: 300_000, max_attempts: 3 };

describe('backoff (research R-22)', () => {
  it('grows by the factor with bounded jitter and never exceeds max_ms', () => {
    for (const [attempt, base] of [
      [1, 5_000],
      [2, 10_000],
      [3, 20_000],
    ] as const) {
      const d = backoffDelay(CFG, attempt, 'start_agent:acme:t1:r1:a1');
      expect(d).toBeGreaterThanOrEqual(base);
      expect(d).toBeLessThanOrEqual(base * 1.1);
    }
    expect(backoffDelay(CFG, 20, 'k')).toBe(300_000);
  });

  it('derives jitter from the key, so the same input gives the same delay', () => {
    expect(backoffDelay(CFG, 2, 'k1')).toBe(backoffDelay(CFG, 2, 'k1'));
    const delays = new Set(['k1', 'k2', 'k3', 'k4', 'k5'].map((k) => backoffDelay(CFG, 2, k)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('stops after max_attempts', () => {
    expect(planBackoff(CFG, 3, 'k', 0)).toMatchObject({ kind: 'wait' });
    expect(planBackoff(CFG, 4, 'k', 0)).toEqual({
      kind: 'exhausted',
      reason: 'max_attempts',
    });
  });

  it('honours reset_at, also one further away than max_ms (#245)', () => {
    expect(planBackoff(CFG, 1, 'k', 1_000, 61_000)).toEqual({
      kind: 'wait',
      due_at: 61_000,
    });
    expect(planBackoff(CFG, 1, 'k', 1_000, 500)).toEqual({
      kind: 'wait',
      due_at: 1_000,
    });
    expect(planBackoff(CFG, 1, 'k', 0, 300_001)).toEqual({
      kind: 'wait',
      due_at: 300_001,
    });
  });
});
