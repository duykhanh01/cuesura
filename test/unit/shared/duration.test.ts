import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../../src/shared/duration.ts';

describe('parseDuration', () => {
  it.each([
    ['45s', 45_000],
    ['10m', 600_000],
    ['6h', 21_600_000],
    ['250ms', 250],
    ['1d', 86_400_000],
    ['0s', 0],
  ])('%s → %d ms', (text, ms) => {
    expect(parseDuration(text)).toEqual({ ok: true, value: ms });
  });

  it.each(['-5s', '5', '5w', '1.5h', '', 's', '10 m', '99999999999999999d'])(
    'rejects %j',
    (text) => {
      expect(parseDuration(text).ok).toBe(false);
    },
  );
});
