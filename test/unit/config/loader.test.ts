import { describe, expect, it } from 'vitest';
import { loadYaml, DEFAULT_LIMITS } from '../../../src/config/yaml-loader.ts';

function errors(
  text: string,
  limits = DEFAULT_LIMITS,
): { code: string; line: number; col: number }[] {
  const r = loadYaml({ file: 'cusr.yaml', text }, limits);
  return r.ok ? [] : r.error.map((d) => ({ code: d.code, line: d.line, col: d.col }));
}

describe('loader YAML (R-05)', () => {
  it('reads YAML core schema; yes/on remain strings', () => {
    const r = loadYaml({
      file: 'a.yaml',
      text: 'a: yes\nb: on\nc: true\nd: 0x10\ne: ~\n',
    });
    expect(r.ok && r.value.value).toEqual({
      a: 'yes',
      b: 'on',
      c: true,
      d: 16,
      e: null,
    });
  });

  it('yaml_syntax reports the correct line and column', () => {
    expect(errors('a: [1, 2\nb: 3\n')).toEqual([{ code: 'yaml_syntax', line: 2, col: 1 }]);
    expect(errors('a:\n\tb: 1\n')).toEqual([{ code: 'yaml_syntax', line: 2, col: 1 }]);
  });

  it('yaml_syntax rejects multiple documents in one file', () => {
    expect(errors('a: 1\n---\nb: 2\n')).toEqual([{ code: 'yaml_syntax', line: 2, col: 1 }]);
  });

  it('duplicate_key reports DUPLICATE_KEY at the repeated key', () => {
    expect(errors('a: 1\nb:\n  c: 2\n  c: 3\n')).toEqual([
      { code: 'duplicate_key', line: 4, col: 3 },
    ]);
  });

  it('unsupported_tag rejects unknown tags despite TAG_RESOLVE_FAILED being a warning', () => {
    expect(errors('a: !foo bar\n')).toEqual([{ code: 'unsupported_tag', line: 1, col: 4 }]);
  });

  it('unsupported_tag rejects !!binary even when yaml resolves it', () => {
    expect(errors('a: 1\nb: !!binary aGk=\n')).toEqual([
      { code: 'unsupported_tag', line: 2, col: 4 },
    ]);
  });

  it('accepts explicit core-schema tags', () => {
    expect(errors('a: !!str 1\nb: !!int "2"\n')).toEqual([]);
  });

  it('alias_limit reports the 51st alias at its position', () => {
    const items = Array.from({ length: 51 }, () => '*x').join(', ');
    expect(errors(`base: &x 1\nlist: [${items}]\n`)).toEqual([
      { code: 'alias_limit', line: 2, col: 8 + 50 * 4 },
    ]);
  });

  it('accepts 50 aliases', () => {
    const items = Array.from({ length: 50 }, () => '*x').join(', ');
    expect(errors(`base: &x 1\nlist: [${items}]\n`)).toEqual([]);
  });

  it('an alias without a preceding anchor is a syntax error', () => {
    expect(errors('a: *nope\n')).toEqual([{ code: 'yaml_syntax', line: 1, col: 4 }]);
  });

  it('file_too_large rejects files over 256 KiB before parsing', () => {
    const big = `a: "${'x'.repeat(256 * 1024)}"\n`;
    expect(errors(big)).toEqual([{ code: 'file_too_large', line: 1, col: 1 }]);
    expect(errors('a: 1\n', { ...DEFAULT_LIMITS, max_file_bytes: 3 })).toEqual([
      { code: 'file_too_large', line: 1, col: 1 },
    ]);
  });

  it('measures size in UTF-8 bytes rather than characters', () => {
    const text = 'a: "ệệ"\n'; // 8 characters, 12 UTF-8 bytes.
    expect(errors(text, { ...DEFAULT_LIMITS, max_file_bytes: 10 })).toEqual([
      { code: 'file_too_large', line: 1, col: 1 },
    ]);
    expect(errors(text, { ...DEFAULT_LIMITS, max_file_bytes: 12 })).toEqual([]);
  });
});
