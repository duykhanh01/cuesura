import { describe, expect, it } from 'vitest';
import { canonicalJson, CanonicalJsonError } from '../../../src/shared/canonical-json.ts';

describe('canonicalJson (R-03)', () => {
  it('sorts keys by code point without whitespace', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: true, c: null }], A: 'x' })).toBe(
      '{"A":"x","a":[3,{"c":null,"d":true}],"b":1}',
    );
  });

  it('compares code points rather than UTF-16 code units', () => {
    // U+FF61 < U+1F600 by code point, but surrogate 0xD83D < 0xFF61 by code unit.
    expect(canonicalJson({ '\u{1F600}': 1, '｡': 2 })).toBe('{"｡":2,"\u{1F600}":1}');
  });

  it('omits undefined keys, preserves array order, and uses JSON.stringify number encoding', () => {
    expect(canonicalJson({ x: undefined, y: [2, 1], z: 1e21, w: -0, v: 0.1 })).toBe(
      '{"v":0.1,"w":0,"y":[2,1],"z":1e+21}',
    );
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['bigint', 1n],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['function', () => 1],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalJson({ v: value })).toThrow(CanonicalJsonError);
  });

  it('accepts objects with null prototypes', () => {
    const o = Object.create(null) as Record<string, number>;
    o['b'] = 2;
    o['a'] = 1;
    expect(canonicalJson(o)).toBe('{"a":1,"b":2}');
  });

  it('rejects cycles while allowing repeated non-circular references', () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(() => canonicalJson(loop)).toThrow(CanonicalJsonError);
  });
});
