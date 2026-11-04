import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_CODES } from '../../../src/config/positions.ts';
import { invalidFixtureNames, runInvalidFixture } from '../../support/config-fixtures.ts';

const names = invalidFixtureNames();

describe('Invalid configuration fixtures', () => {
  it.each(names)('%s', (name) => {
    const { header, actual } = runInvalidFixture(name);
    expect(header.expect.length).toBeGreaterThan(0);
    expect(actual).toEqual(header.expect);
  });

  it('every diagnostic code has at least one fixture', () => {
    const covered = new Set(
      names.flatMap((n) => runInvalidFixture(n).header.expect.map((e) => e.code)),
    );
    expect(DIAGNOSTIC_CODES.filter((c) => !covered.has(c))).toEqual([]);
  });
});
