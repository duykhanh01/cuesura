import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { colorEnabled, diffFrames, Frame, has256Colors } from '../../../src/tui/terminal/screen.ts';

function show(frames: Frame[], cols = 10, rows = 3): Promise<string[]> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  let prev: Frame | null = null;
  let bytes = '';
  for (const f of frames) {
    bytes += diffFrames(prev, f);
    prev = f;
  }
  return new Promise((resolve) => {
    term.write(bytes, () => {
      const lines: string[] = [];
      for (let y = 0; y < rows; y++)
        lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '');
      term.dispose();
      resolve(lines);
    });
  });
}

const text = uiText;

describe('Frame', () => {
  it('places text at a position', async () => {
    const f = new Frame(10, 3);
    f.put(2, 1, text('hi'));
    expect(await show([f])).toEqual(['', '  hi', '']);
  });

  it('clips at the right edge and below the bottom', async () => {
    const f = new Frame(5, 2);
    f.put(3, 0, text('abcdef'));
    f.put(0, 5, text('nope'));
    expect(await show([f], 5, 2)).toEqual(['   ab', '']);
  });

  it('a wide character takes two cells and is not split at the edge', async () => {
    const f = new Frame(5, 2);
    f.put(0, 0, sanitize('日本語'));
    f.put(0, 1, sanitize('日'));
    f.put(2, 1, text('x'));
    expect(await show([f], 5, 2)).toEqual(['日本', '日x']);
  });

  it('overwriting half a wide character leaves no half behind', async () => {
    const f = new Frame(6, 1);
    f.put(0, 0, sanitize('日本'));
    f.put(1, 0, text('x'));
    expect(await show([f], 6, 1)).toEqual([' x本']);
  });

  it('a combining mark stays with its letter', async () => {
    const f = new Frame(6, 1);
    f.put(0, 0, sanitize('ếx'));
    expect(await show([f], 6, 1)).toEqual(['ếx']);
  });

  it('a line filling the last column survives', async () => {
    const f = new Frame(3, 2);
    f.put(0, 0, text('abc'));
    f.put(0, 1, text('def'));
    expect(await show([f], 3, 2)).toEqual(['abc', 'def']);
  });

  it('writes style only where it applies', () => {
    const f = new Frame(8, 1);
    f.put(0, 0, text('ab'), { fg: 'red', bold: true });
    f.put(2, 0, text('cd'));
    const bytes = f.rowBytes(0);
    expect(bytes).toContain('\x1b[1;31mab');
    expect(bytes).toContain('\x1b[0mcd');
  });

  it('colour off keeps bold and inverse, the marks that are not colour', () => {
    const f = new Frame(4, 1, { color: false });
    f.put(0, 0, text('a'), { fg: 'red', bold: true, inverse: true });
    expect(f.rowBytes(0)).toContain('\x1b[1;7ma');
    expect(f.rowBytes(0)).not.toContain('31');
  });
});

describe('colorEnabled', () => {
  it('follows NO_COLOR', () => {
    expect(colorEnabled({})).toBe(true);
    expect(colorEnabled({ NO_COLOR: '' })).toBe(true);
    expect(colorEnabled({ NO_COLOR: '1' })).toBe(false);
  });

  it('is off for a terminal that takes no colour by name', () => {
    for (const TERM of ['vt100', 'vt220', 'xterm-mono', 'xterm-m'])
      expect(colorEnabled({ TERM })).toBe(false);
    for (const TERM of ['xterm-256color', 'screen', 'tmux-256color', 'linux'])
      expect(colorEnabled({ TERM })).toBe(true);
  });
});

describe('256 colours', () => {
  it('are known from TERM or COLORTERM', () => {
    expect(has256Colors({ TERM: 'xterm-256color' })).toBe(true);
    expect(has256Colors({ TERM: 'xterm', COLORTERM: 'truecolor' })).toBe(true);
    expect(has256Colors({ TERM: 'xterm' })).toBe(false);
    expect(has256Colors({ TERM: 'linux' })).toBe(false);
  });

  it('draw orange and gray from the palette, or the nearest of 16 colours without it', () => {
    const sgr = (colors256: boolean): string => {
      const f = new Frame(2, 1, { colors256 });
      f.put(0, 0, text('a'), { fg: 'orange' });
      f.put(1, 0, text('b'), { fg: 'gray' });
      return diffFrames(null, f);
    };
    expect(sgr(true)).toContain('\x1b[38;5;173ma');
    expect(sgr(true)).toContain('\x1b[38;5;238mb');
    expect(sgr(false)).toContain('\x1b[33ma');
    expect(sgr(false)).toContain('\x1b[90mb');
  });
});

describe('diffFrames', () => {
  it('writes only the rows that changed', () => {
    const a = new Frame(5, 3);
    a.put(0, 0, text('same'));
    a.put(0, 1, text('old'));
    const b = new Frame(5, 3);
    b.put(0, 0, text('same'));
    b.put(0, 1, text('new'));
    expect(diffFrames(a, b)).toBe('\x1b[2;1H\x1b[2Knew');
  });

  it('writes nothing when nothing changed', () => {
    const a = new Frame(5, 3);
    a.put(0, 0, text('x'));
    const b = new Frame(5, 3);
    b.put(0, 0, text('x'));
    expect(diffFrames(a, b)).toBe('');
  });

  it('redraws everything with no previous frame and after a size change', () => {
    const a = new Frame(5, 2);
    expect(diffFrames(null, a)).toBe('\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K');
    const b = new Frame(6, 2);
    expect(diffFrames(a, b)).toBe('\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K');
  });

  it('a later frame clears what an earlier one wrote', async () => {
    const a = new Frame(5, 2);
    a.put(0, 0, text('xxxxx'));
    const b = new Frame(5, 2);
    b.put(0, 0, text('y'));
    expect(await show([a, b], 5, 2)).toEqual(['y', '']);
  });
});
