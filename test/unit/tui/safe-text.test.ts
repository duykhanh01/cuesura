import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { joinSafe, sanitize, sanitizeLines, uiText } from '../../../src/tui/terminal/safe-text.ts';

// eslint-disable-next-line no-control-regex -- the test looks for exactly these.
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

describe('sanitize', () => {
  it('neutralizes escape sequences, leaving them visible', () => {
    expect(sanitize('\x1b[31mred\x1b[0m')).toBe('␛[31mred␛[0m');
    expect(sanitize('\x1b]0;title\x07')).toBe('␛]0;title␇');
  });

  it('replaces C0, DEL and C1', () => {
    expect(sanitize('a\x00b')).toBe('a␀b');
    expect(sanitize('a\x7fb')).toBe('a␡b');
    expect(sanitize('a\x9bb')).toBe('a�b');
    expect(sanitize('a\x85b')).toBe('a�b');
  });

  it.each([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])(
    'replaces the bidi control U+%s',
    (code) => {
      expect(sanitize(`a${String.fromCodePoint(code)}b`)).toBe('a�b');
    },
  );

  it('turns a tab into a space', () => {
    expect(sanitize('a\tb')).toBe('a b');
  });

  it('shows a line break as a symbol on a single line', () => {
    expect(sanitize('a\nb\rc')).toBe('a␊b␍c');
  });

  it('keeps Vietnamese, combining marks, ZWJ and ZWNJ', () => {
    for (const text of [
      'Tiếng Việt có dấu',
      'Tiếng', // Combining form.
      '👨‍👩‍👧', // ZWJ sequence.
      'a‌b', // ZWNJ.
      '日本語',
    ])
      expect(sanitize(text)).toBe(text);
  });

  it('replaces a lone surrogate', () => {
    expect(sanitize('a\ud800b')).toBe('a�b');
  });

  it('leaves no control character in any input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const out = sanitize(s);
        expect(FORBIDDEN.test(out)).toBe(false);
        expect(out).not.toContain('\n');
        expect(out).not.toContain('\t');
      }),
    );
  });
});

describe('sanitizeLines', () => {
  it('keeps line feeds and nothing else', () => {
    expect(sanitizeLines('a\nb\r\n\x1b[2Jc\td')).toBe('a\nb␍\n␛[2Jc d');
  });

  it('leaves no control character but the line feed in any input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(FORBIDDEN.test(sanitizeLines(s))).toBe(false);
      }),
    );
  });
});

it('fixed text and joins keep their content', () => {
  expect(joinSafe([uiText('a'), sanitize('b')], ' ')).toBe('a b');
});
