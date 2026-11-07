import { describe, expect, it } from 'vitest';
import { keptFindings, reviewSignature, untouchedRepeats } from '../../../src/engine/failure.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';

describe('review failure signature', () => {
  const findings = [
    { severity: 'major', file: 'ä.ts', msg: 'missing test' },
    { severity: 'critical', file: 'z.ts', msg: 'drops rows' },
    { severity: 'minor', file: 'n.ts', msg: 'naming' },
  ];

  it('does not depend on the order of findings', () => {
    expect(reviewSignature([...findings].reverse())).toBe(reviewSignature(findings));
  });

  it('is the blocking files in code-unit order, not by locale collation', () => {
    // Code-unit order puts 'ä' (U+00E4) after 'z', as sv collation does and en collation does not.
    const expected = `review:${hashCanonical(['z.ts', 'ä.ts']).slice('sha256:'.length, 'sha256:'.length + 16)}`;
    expect(reviewSignature(findings)).toBe(expected);
  });

  it('stays the same when the reviewer rewords, changes severity within blocking, or adds minor findings', () => {
    const again = [
      { severity: 'critical', file: 'ä.ts', msg: 'still no test for the empty case' },
      { severity: 'major', file: 'z.ts', msg: 'rows are still dropped', line: 9 },
      { severity: 'minor', file: 'other.ts', msg: 'new nit' },
      { severity: 'info', msg: 'note' },
    ];
    expect(reviewSignature(again)).toBe(reviewSignature(findings));
  });

  it('changes when the blocking files change', () => {
    expect(reviewSignature([{ severity: 'major', file: 'z.ts', msg: 'm' }])).not.toBe(
      reviewSignature(findings),
    );
  });

  it('falls back to every finding without a blocking one, and is null without findings', () => {
    expect(reviewSignature([{ severity: 'minor', file: 'n.ts', msg: 'a' }])).toBe(
      reviewSignature([{ severity: 'info', file: 'n.ts', msg: 'b' }]),
    );
    expect(reviewSignature([])).toBeNull();
  });
});

describe('blocking findings the fix left alone', () => {
  const prior = {
    revision: 1,
    valid: true,
    verdict: 'request_changes',
    sha: 'a',
    findings: [
      { severity: 'major', file: 'src/app.ts', msg: 'not wired' },
      { severity: 'critical', file: 'src/db.ts', msg: 'drops rows' },
      { severity: 'minor', file: 'src/n.ts', msg: 'naming' },
    ],
  };
  const now = [
    { severity: 'major', file: 'src/app.ts', msg: 'still not wired' },
    { severity: 'major', file: 'src/db.ts', msg: 'still drops rows' },
    { severity: 'major', file: 'src/n.ts', msg: 'was minor before' },
    { severity: 'major', file: 'src/new.ts', msg: 'new' },
  ];

  it('are the files blocked on in both reviews that no commit since changed', () => {
    expect(
      untouchedRepeats([prior], 1, {
        findings: now,
        changed_since: { sha: 'a', paths: ['src/db.ts', 'src/n.ts'] },
      }),
    ).toEqual(['src/app.ts']);
  });

  it('are none without a previous rejection of this revision, or without the files changed since it', () => {
    const changed = { sha: 'a', paths: [] };
    expect(untouchedRepeats([], 1, { findings: now, changed_since: changed })).toEqual([]);
    expect(
      untouchedRepeats([{ ...prior, verdict: 'approve' }], 1, {
        findings: now,
        changed_since: changed,
      }),
    ).toEqual([]);
    expect(untouchedRepeats([prior], 2, { findings: now, changed_since: changed })).toEqual([]);
    expect(untouchedRepeats([prior], 1, { findings: now })).toEqual([]);
    expect(
      untouchedRepeats([prior], 1, { findings: now, changed_since: { sha: 'b', paths: [] } }),
    ).toEqual([]);
  });
});

describe('findings kept with a review', () => {
  const f = (severity: string, file: string) => ({ severity, file, msg: 'm' });
  it('keeps every blocking finding first, then the others, in their order', () => {
    const all = [
      f('minor', 'a'),
      f('major', 'b'),
      f('minor', 'c'),
      f('critical', 'd'),
      f('info', 'e'),
    ];
    expect(keptFindings(all, 3)).toEqual([f('minor', 'a'), f('major', 'b'), f('critical', 'd')]);
    expect(keptFindings(all, 10)).toEqual(all);
    expect(keptFindings([f('major', 'x'), f('major', 'y')], 1)).toEqual([f('major', 'x')]);
    // Positions count, not object identity.
    const same = f('minor', 'a');
    expect(keptFindings([same, same, same], 2)).toHaveLength(2);
  });
});
