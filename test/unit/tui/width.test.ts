import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitize } from '../../../src/tui/terminal/safe-text.ts';
import {
  displayWidth,
  graphemes,
  padEnd,
  truncate,
  truncateMiddle,
  wrap,
} from '../../../src/tui/terminal/width.ts';

const FAMILY = '👨‍👩‍👧';
const COMPOSED = 'Tiếng';

describe('display width', () => {
  it.each([
    ['abc', 3],
    ['Tiếng Việt', 10],
    [COMPOSED, 5],
    ['日本語', 6],
    [FAMILY, 2],
    ['', 0],
  ])('%s takes %i cells', (text, cells) => {
    expect(displayWidth(text)).toBe(cells);
  });

  it('splits by grapheme', () => {
    expect(graphemes(COMPOSED)).toEqual(['T', 'i', 'ế', 'n', 'g']);
    expect(graphemes(`a${FAMILY}b`)).toEqual(['a', FAMILY, 'b']);
  });
});

describe('truncate', () => {
  it('leaves text that fits', () => {
    expect(truncate(sanitize('hello'), 5)).toBe('hello');
  });

  it('cuts with an ellipsis', () => {
    expect(truncate(sanitize('hello world'), 8)).toBe('hello w…');
  });

  it('never splits a Vietnamese letter, a CJK character or an emoji', () => {
    expect(truncate(sanitize(`${COMPOSED} abc`), 4)).toBe('Tiế…');
    expect(truncate(sanitize('日本語です'), 6)).toBe('日本…');
    expect(truncate(sanitize(`a${FAMILY}${FAMILY}b`), 5)).toBe(`a${FAMILY}…`);
  });

  it('a wide character that does not fit leaves a shorter result, not an overflow', () => {
    expect(displayWidth(truncate(sanitize('日本語'), 4))).toBe(3);
  });

  it('handles the smallest widths', () => {
    expect(truncate(sanitize('abc'), 0)).toBe('');
    expect(truncate(sanitize('abc'), -1)).toBe('');
    expect(truncate(sanitize('abc'), 1)).toBe('…');
  });

  it('never exceeds the width for any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), fc.nat(40), (s, cols) => {
        expect(displayWidth(truncate(sanitize(s), cols))).toBeLessThanOrEqual(cols);
      }),
    );
  });
});

describe('padEnd', () => {
  it('fills by cells, not by characters', () => {
    expect(padEnd(sanitize('日本'), 6)).toBe('日本  ');
    expect(padEnd(sanitize('abc'), 2)).toBe('abc');
  });
});

describe('truncateMiddle', () => {
  it('leaves text that fits alone', () => {
    expect(truncateMiddle(sanitize('short'), 5)).toBe('short');
  });

  it('keeps both ends', () => {
    expect(truncateMiddle(sanitize('abcdefghij'), 5)).toBe('ab…ij');
  });

  it('keeps graphemes whole and never exceeds the width', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 40 }), (raw, cols) => {
        const cut = truncateMiddle(sanitize(raw + FAMILY.repeat(30)), cols);
        expect(displayWidth(cut)).toBeLessThanOrEqual(cols);
      }),
    );
  });
});

describe('wrap', () => {
  it('breaks at spaces and keeps every word', () => {
    expect(wrap(sanitize('one two three four'), 9)).toEqual(['one two', 'three', 'four']);
  });

  it('splits a word wider than the row, losing nothing', () => {
    const path = `/home/${'a'.repeat(30)}/token`;
    const rows = wrap(sanitize(`file ${path}: bad`), 10);
    expect(rows.join('').replaceAll(' ', '')).toBe(`file${path}:bad`);
    expect(rows.every((r) => displayWidth(r) <= 10)).toBe(true);
  });

  it('keeps graphemes whole and line feeds as breaks', () => {
    expect(wrap(sanitize(FAMILY + FAMILY), 2)).toEqual([FAMILY, FAMILY]);
    expect(wrap('a\nb' as ReturnType<typeof sanitize>, 5)).toEqual(['a', 'b']);
  });

  it('never exceeds the width', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 2, max: 40 }), (raw, cols) => {
        for (const row of wrap(sanitize(raw), cols))
          expect(displayWidth(row)).toBeLessThanOrEqual(cols);
      }),
    );
  });

  it('has no rows for no width', () => {
    expect(wrap(sanitize('x'), 0)).toEqual([]);
  });
});
