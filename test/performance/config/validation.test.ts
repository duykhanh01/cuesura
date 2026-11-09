import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/validate.ts';
import { PACKS, source } from '../../support/config-fixtures.ts';

// SC-002: median validation time for the 500-line fixture over 20 runs must stay below one second.
describe('validateConfig performance', () => {
  it('validates large-500.yaml in under one second over 20-run medians', () => {
    const user = source('configs/valid/large-500.yaml');
    expect(user.text.split('\n').length - 1).toBe(500);
    const project = source('configs/valid/cusr.yaml', 'cusr.yaml');
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = validateConfig({ user, project, packs: PACKS });
      times.push(performance.now() - t0);
      expect(r.ok).toBe(true);
    }
    times.sort((a, b) => a - b);
    const median = ((times[9] as number) + (times[10] as number)) / 2;
    expect(median).toBeLessThan(1_000);
  });
});
