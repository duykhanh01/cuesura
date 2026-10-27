import { describe, expect, it } from 'vitest';
import { reviewSignature } from '../../../src/engine/failure.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';

describe('review failure signature', () => {
  const findings = [
    { severity: 'major', file: 'ä.ts', msg: 'missing test' },
    { severity: 'major', file: 'z.ts', msg: 'missing test' },
    { severity: 'minor', msg: 'naming' },
  ];

  it('does not depend on the order of findings', () => {
    expect(reviewSignature([...findings].reverse())).toBe(reviewSignature(findings));
  });

  it('sorts by code unit rather than by locale collation', () => {
    // Code-unit order puts 'ä' (U+00E4) after 'z', as sv collation does and en collation does not.
    const keys = findings.map((f) => [f.severity, f.file ?? '', f.msg].join('\0'));
    const expected = `review:${hashCanonical([...keys].sort()).slice('sha256:'.length, 'sha256:'.length + 16)}`;
    expect(reviewSignature(findings)).toBe(expected);
    expect(['major\0z.ts', 'major\0ä.ts'].sort()).toEqual(['major\0z.ts', 'major\0ä.ts']);
  });

  it('is null when the review has no findings', () => {
    expect(reviewSignature([])).toBeNull();
  });
});
