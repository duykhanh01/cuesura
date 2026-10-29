import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_CODES } from '../../../src/config/positions.ts';
import {
  invalidFixtureNames,
  runInvalidFixture,
} from '../../support/config-fixtures.ts';

const names = invalidFixtureNames();

// SC-001: mỗi lỗi chỉ đúng file, dòng, cột như comment đầu fixture.
describe('fixture cấu hình không hợp lệ', () => {
  it.each(names)('%s', (name) => {
    const { header, actual } = runInvalidFixture(name);
    expect(header.expect.length).toBeGreaterThan(0);
    expect(actual).toEqual(header.expect);
  });

  it('mỗi mã chẩn đoán có ít nhất một fixture', () => {
    const covered = new Set(
      names.flatMap((n) =>
        runInvalidFixture(n).header.expect.map((e) => e.code),
      ),
    );
    expect(DIAGNOSTIC_CODES.filter((c) => !covered.has(c))).toEqual([]);
  });
});
