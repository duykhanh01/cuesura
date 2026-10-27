import { describe, expect, it } from 'vitest';
import { loadYaml, DEFAULT_LIMITS } from '../../../src/config/yaml-loader.ts';

function errors(text: string, limits = DEFAULT_LIMITS): { code: string; line: number; col: number }[] {
  const r = loadYaml({ file: 'cusr.yaml', text }, limits);
  return r.ok ? [] : r.error.map((d) => ({ code: d.code, line: d.line, col: d.col }));
}

// Chốt hành vi thực tế của `yaml` 2 mà research R-05 ghi "Cần kiểm chứng".
describe('loader YAML (R-05)', () => {
  it('đọc được YAML hợp lệ theo core schema; yes/on là chuỗi, không phải bool', () => {
    const r = loadYaml({ file: 'a.yaml', text: 'a: yes\nb: on\nc: true\nd: 0x10\ne: ~\n' });
    expect(r.ok && r.value.value).toEqual({ a: 'yes', b: 'on', c: true, d: 16, e: null });
  });

  it('yaml_syntax: chỉ đúng dòng/cột lỗi', () => {
    expect(errors('a: [1, 2\nb: 3\n')).toEqual([{ code: 'yaml_syntax', line: 2, col: 1 }]);
    expect(errors('a:\n\tb: 1\n')).toEqual([{ code: 'yaml_syntax', line: 2, col: 1 }]);
  });

  it('yaml_syntax: nhiều document trong một file bị từ chối', () => {
    expect(errors('a: 1\n---\nb: 2\n')).toEqual([{ code: 'yaml_syntax', line: 2, col: 1 }]);
  });

  it('duplicate_key: `yaml` 2 báo DUPLICATE_KEY tại khoá lặp lại', () => {
    expect(errors('a: 1\nb:\n  c: 2\n  c: 3\n')).toEqual([{ code: 'duplicate_key', line: 4, col: 3 }]);
  });

  it('unsupported_tag: tag lạ chỉ là cảnh báo TAG_RESOLVE_FAILED của `yaml` 2 nhưng vẫn chặn', () => {
    expect(errors('a: !foo bar\n')).toEqual([{ code: 'unsupported_tag', line: 1, col: 4 }]);
  });

  it('unsupported_tag: !!binary được `yaml` 2 resolve dù dùng core schema, loader vẫn từ chối', () => {
    expect(errors('a: 1\nb: !!binary aGk=\n')).toEqual([{ code: 'unsupported_tag', line: 2, col: 4 }]);
  });

  it('tag tường minh của core schema được chấp nhận', () => {
    expect(errors('a: !!str 1\nb: !!int "2"\n')).toEqual([]);
  });

  it('alias_limit: alias thứ 51 bị báo tại chính nó', () => {
    const items = Array.from({ length: 51 }, () => '*x').join(', ');
    expect(errors(`base: &x 1\nlist: [${items}]\n`)).toEqual([{ code: 'alias_limit', line: 2, col: 8 + 50 * 4 }]);
  });

  it('50 alias vẫn được chấp nhận', () => {
    const items = Array.from({ length: 50 }, () => '*x').join(', ');
    expect(errors(`base: &x 1\nlist: [${items}]\n`)).toEqual([]);
  });

  it('alias chưa có anchor là lỗi cú pháp (`yaml` 2 chỉ ném lỗi khi toJS)', () => {
    expect(errors('a: *nope\n')).toEqual([{ code: 'yaml_syntax', line: 1, col: 4 }]);
  });

  it('file_too_large: vượt 256 KiB bị từ chối trước khi parse', () => {
    const big = `a: "${'x'.repeat(256 * 1024)}"\n`;
    expect(errors(big)).toEqual([{ code: 'file_too_large', line: 1, col: 1 }]);
    expect(errors('a: 1\n', { ...DEFAULT_LIMITS, max_file_bytes: 3 })).toEqual([{ code: 'file_too_large', line: 1, col: 1 }]);
  });

  it('kích thước tính theo byte UTF-8, không theo ký tự', () => {
    const text = 'a: "ệệ"\n'; // 8 ký tự, 12 byte
    expect(errors(text, { ...DEFAULT_LIMITS, max_file_bytes: 10 })).toEqual([{ code: 'file_too_large', line: 1, col: 1 }]);
    expect(errors(text, { ...DEFAULT_LIMITS, max_file_bytes: 12 })).toEqual([]);
  });
});
