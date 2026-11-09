import { describe, expect, it } from 'vitest';
import { hashCanonical } from '../../../src/shared/hash.ts';

describe('hashCanonical', () => {
  it('key order does not change object hashes', () => {
    const a = hashCanonical({ x: 1, y: { b: [1, 2], a: 'q' } });
    const b = hashCanonical({ y: { a: 'q', b: [1, 2] }, x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('different values and array order produce different hashes', () => {
    expect(hashCanonical({ x: 1 })).not.toBe(hashCanonical({ x: 2 }));
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });

  it('hashes remain stable across runs', () => {
    expect(hashCanonical({})).toBe(
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });
});
